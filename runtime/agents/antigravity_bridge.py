#!/usr/bin/env python3
"""EnoughFactory's container-only, JSONL bridge for Google Antigravity SDK.

The device service owns this process, its container and approval policy. stdout
is a protocol channel; SDK logging and incidental prints go to stderr.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import signal
import sys
from typing import Any
import uuid


SDK_VERSION = "0.1.20"
PROTOCOL_VERSION = 1
PROTOCOL_STDOUT = sys.stdout
# Native SDK children have their own pipes. Python prints must not corrupt ours.
sys.stdout = sys.stderr


def emit(record: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(record, ensure_ascii=False) + "\n")
    PROTOCOL_STDOUT.flush()


def safe_error(error: BaseException) -> str:
    message = str(error)
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"):
        secret = os.environ.get(name)
        if secret:
            message = message.replace(secret, "[redacted]")
    return message


def load_sdk() -> tuple[Any, Any, Any, Any, Any]:
    installed = importlib.metadata.version("google-antigravity")
    if installed != SDK_VERSION:
        raise RuntimeError(
            f"Antigravity SDK {installed} is installed; EnoughFactory requires "
            f"google-antigravity=={SDK_VERSION}."
        )
    from google.antigravity import Agent, LocalAgentConfig, types
    from google.antigravity.hooks import hooks, policy

    return Agent, LocalAgentConfig, types, hooks, policy


def decode_input(line: bytes) -> dict[str, Any]:
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("Protocol messages must be JSON objects.")
    return value


class Bridge:
    def __init__(self, start: dict[str, Any], sdk: tuple[Any, ...]) -> None:
        self.start = start
        self.Agent, self.LocalAgentConfig, self.types, self.hooks, self.policy = sdk
        self.turn_id = str(uuid.uuid4())
        self.pending: dict[str, tuple[str, asyncio.Future[Any]]] = {}
        self.stop = asyncio.Event()
        self.stop_reason = "cancelled"
        self.response: Any = None
        self.thread_id: str | None = None
        self.retired = False

    def send(self, record: dict[str, Any]) -> None:
        emit({**record, "turnId": self.turn_id})

    def event(self, kind: str, **payload: Any) -> None:
        self.send({"type": "event", "event": {"kind": kind, **payload}})

    async def request(self, kind: str, **payload: Any) -> Any:
        if self.retired:
            raise asyncio.CancelledError()
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = (kind, future)
        self.send({"type": kind, "id": request_id, **payload})
        try:
            return await future
        finally:
            self.pending.pop(request_id, None)

    async def approve(self, call: Any, reason: str | None = None) -> bool:
        # allow_all removes workspace containment; this callback delegates the
        # decision to Enough for every exposed tool, including Approve all.
        approved = await self.request(
            "approval",
            action=str(call.name.value if hasattr(call.name, "value") else call.name),
            arguments=call.args,
            nativeId=call.id,
            stepId=call.step_id,
            canonicalPath=call.canonical_path,
            serverName=call.server_name,
            reason=reason,
            approvalMode=self.start.get("approvalMode", "approve-all"),
        )
        return approved

    async def ask_question(self, spec: Any) -> Any:
        answer = await self.request(
            "question", questions=spec.model_dump(mode="json")["questions"]
        )
        return self.types.QuestionHookResult.model_validate(answer)

    def retire(self, reason: str) -> None:
        if self.retired:
            return
        self.retired = True
        self.stop_reason = reason
        # Approval/question callbacks never survive the process generation.
        for _, future in self.pending.values():
            if not future.done():
                future.cancel()
        self.pending.clear()
        self.stop.set()

    async def inputs(self, reader: asyncio.StreamReader) -> None:
        while not self.retired:
            line = await reader.readline()
            if not line:
                self.retire("input-closed")
                return
            try:
                message = decode_input(line)
                message_type = message.get("type")
                if message_type in ("cancel", "shutdown"):
                    self.retire(message_type)
                    return
                if message_type not in ("approval-response", "question-response"):
                    raise ValueError(f"Unsupported message type: {message_type!r}")
                request_id = message.get("id")
                pending = self.pending.get(request_id) if isinstance(request_id, str) else None
                if pending is None:
                    self.event("request-ignored", id=request_id, reason="unknown-or-retired")
                    continue
                kind, future = pending
                if message_type != kind + "-response":
                    raise ValueError("Response type does not match its pending request.")
                if kind == "approval":
                    approved = message.get("approved")
                    if not isinstance(approved, bool):
                        raise ValueError("Approval responses require approved: boolean.")
                    value = approved
                else:
                    value = {
                        "responses": message.get("answers", message.get("responses")),
                        "cancelled": message.get("cancelled", False),
                    }
                    value = self.types.QuestionHookResult.model_validate(value).model_dump(
                        mode="json"
                    )
                if not future.done():
                    future.set_result(value)
                    self.event("request-resolved", id=request_id, requestType=kind, decision=value)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send({"type": "error", "code": "invalid-input", "message": safe_error(error)})

    def config(self) -> Any:
        prompt = self.start.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Start requires a nonempty prompt string.")
        approval_mode = self.start.get("approvalMode", "approve-all")
        if approval_mode not in ("approve-all", "rules", "manual"):
            raise ValueError("approvalMode must be approve-all, rules or manual.")
        requested_thread = self.start.get("threadId")
        if requested_thread is not None and not isinstance(requested_thread, str):
            raise ValueError("threadId must be the SDK conversation ID string.")
        save_dir = self.start.get("saveDir") or os.environ.get("ENOUGHFACTORY_AGY_SAVE_DIR")
        save_dir = save_dir or str(Path.home() / ".local/share/EnoughFactory/antigravity")
        if not isinstance(save_dir, str):
            raise ValueError("saveDir must be a string.")
        Path(save_dir).mkdir(parents=True, exist_ok=True)
        command_config = self.types.RunCommandConfig(enable_sandbox=False, enable_daemons=True)
        capabilities = self.types.CapabilitiesConfig(
            enabled_tools=self.types.BuiltinTools.all_tools(),
            run_command_config=command_config,
        )
        # Without explicit capabilities, static SDK subagents default to read-only.
        worker = self.types.SubagentConfig(
            name="worker",
            description="Implement, investigate or verify a delegated piece of the current goal.",
            capabilities=self.types.SubagentCapabilities(
                enabled_tools=self.types.BuiltinTools.all_tools(),
                run_command_config=command_config,
            ),
        )
        # Agent deep-copies its config. Functions keep the live Bridge closure;
        # bound methods would deep-copy its pending requests and SDK modules.
        async def approve(call: Any, reason: str | None = None) -> bool:
            return await self.approve(call, reason)

        async def question(spec: Any) -> Any:
            return await self.ask_question(spec)

        config_args: dict[str, Any] = {
            "capabilities": capabilities,
            "subagents": [worker],
            "workspaces": [str(Path.cwd())],
            "save_dir": save_dir,
            # ASK_USER precedes wildcard APPROVE in SDK policy ordering.
            # Keep the allow_all marker: wildcard ASK alone retains containment.
            "policies": [self.policy.allow_all(), self.policy.ask_user("*", handler=approve)],
            "hooks": [self.hooks.on_interaction(question)],
            "conversation_id": requested_thread,
        }
        if requested_thread:
            # A stale/absent trajectory is an error, never an implicit new chat.
            config_args["session_continuation_mode"] = self.types.SessionContinuationMode.RESUME
        for input_name, sdk_name in (("model", "model"), ("systemInstructions", "system_instructions")):
            if self.start.get(input_name) is not None:
                config_args[sdk_name] = self.start[input_name]
        return self.LocalAgentConfig(**config_args)

    def announce_thread(self, agent: Any) -> None:
        current = agent.conversation_id
        if current and current != self.thread_id:
            self.thread_id = current
            self.event("thread-started", threadId=current)

    async def execute(self) -> None:
        config = self.config()
        self.event(
            "runtime-starting", sdkVersion=SDK_VERSION,
            approvalMode=self.start.get("approvalMode", "approve-all"),
            fullAccess=True, commandSandbox=False,
        )
        async with self.Agent(config) as agent:
            self.announce_thread(agent)
            self.response = await agent.chat(self.start["prompt"])
            self.announce_thread(agent)
            async for chunk in self.response.chunks:
                self.announce_thread(agent)
                if isinstance(chunk, self.types.Text):
                    self.event("text-delta", text=chunk.text)
                elif isinstance(chunk, self.types.Thought):
                    # Internal reasoning is not part of Enough's chat transcript.
                    continue
                elif isinstance(chunk, self.types.ToolCall):
                    self.event("tool-call", tool=chunk.model_dump(mode="json"))
                elif isinstance(chunk, self.types.ToolResult):
                    self.event("tool-result", tool=chunk.model_dump(mode="json", exclude={"exception"}))
                else:
                    self.event("runtime-event", data=chunk.model_dump(mode="json"))
            self.announce_thread(agent)
            usage = self.response.usage_metadata
            reason = self.response.stop_reason
            result = {
                "type": "result",
                "threadId": self.thread_id,
                "text": await self.response.text(),
                "usage": usage.model_dump(mode="json") if usage is not None else None,
                "stopReason": reason.value,
                "structuredOutput": await self.response.structured_output(),
                "saveDir": config.save_dir,
            }
        # Report completion only after the native connection closes and its
        # trajectory store is ready for the next process to resume.
        self.send(result)

    async def run(self, reader: asyncio.StreamReader) -> int:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.retire, sig.name)
        input_task = asyncio.create_task(self.inputs(reader))
        execute_task = asyncio.create_task(self.execute())
        stop_task = asyncio.create_task(self.stop.wait())
        try:
            done, _ = await asyncio.wait(
                (execute_task, input_task, stop_task), return_when=asyncio.FIRST_COMPLETED
            )
            if execute_task in done:
                await execute_task
                return 0
            if input_task in done:
                await input_task
            self.retire(self.stop_reason)
            if self.response is not None:
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await asyncio.wait_for(self.response.cancel(), timeout=2)
            execute_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await execute_task
            self.event("interrupted", reason=self.stop_reason, threadId=self.thread_id)
            return 130
        finally:
            self.retire("finished")
            for task in (input_task, execute_task, stop_task):
                task.cancel()
            await asyncio.gather(input_task, execute_task, stop_task, return_exceptions=True)
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)


async def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        sdk = load_sdk()
        if sys.argv[1:] == ["--check"]:
            emit({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "sdkVersion": SDK_VERSION, "fullAccess": True,
                "approvalChannel": "typed-sdk-policy", "resume": True,
            })
            return 0
        if sys.argv[1:]:
            raise ValueError("Only --check is supported; send a start record on stdin.")
        reader = asyncio.StreamReader(limit=2 * 1024 * 1024)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
        try:
            line = await reader.readline()
            if not line:
                raise ValueError("Input closed before the start message.")
            start = decode_input(line)
            if start.get("type", "start") != "start":
                raise ValueError("The first message must be a start record.")
            return await Bridge(start, sdk).run(reader)
        finally:
            transport.close()
    except importlib.metadata.PackageNotFoundError:
        emit({
            "type": "error", "code": "missing-sdk",
            "message": f"Install google-antigravity=={SDK_VERSION} inside the agent container.",
        })
    except Exception as error:
        emit({"type": "error", "code": "runtime-error", "message": safe_error(error)})
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
