# Assembled factory journey

`node --import tsx scripts/factory-smoke.ts` runs one bounded real-provider journey. It requires EnoughFactory's bundled container-runtime assets, the built envmux binary, and a host Codex account already signed in. The device service starts its private engine. The script uses a disposable Git repository and an isolated device-service home; it does not invoke the user's Docker or alter a contributor's projects, contexts, daemon, images or volumes.

The service receives a real autonomous goal under Approve all. Independent Codex planner, implementation worker and evaluator turns run inside envmux containers. The objective is a small useful shell CLI with focused behavioral checks and documentation. The factory checks and integrates the candidate and evaluates the actual resulting repository. The default scenario now focuses on the changed ownership boundary: every saved envmux readiness descriptor must use the managed runtime's private socket, despite deliberately unusable inherited Docker settings.

The script checks runtime-owned storage/socket, the planner/worker/evaluator endpoint descriptors, one integration, host Git source, CLI behavior and evaluator evidence tied to the integrated head. Normal runtime storage sits inside the isolated application home. A long Mac home may use the manager's short `/Users/Shared` allocation; the script verifies the fixture-specific path, its private location receipt, user ownership and 0700 directory permissions. It writes sanitized `factory-managed-runtime-evidence.json` only after these assertions pass. Transcripts and access credentials stay in the disposable service home. Cleanup asks this same device service to stop only its own idle runtime; active failed work is retained for diagnosis.

`ENOUGHFACTORY_SMOKE_RECOVERY=1` additionally pauses coordination while the authorized worker finishes, retains its candidate, restarts the service and verifies the same goal/task/attempt identities resume. That recovery scenario already passed under the earlier engine integration; repeating it is optional for changes that affect recovery.

This journey is deliberately outside routine CI because it uses real inference and account credentials. It is not evidence for desktop packaging, browser interaction, cross-device transport, ArtifactFS mounts, or selective approval coverage; those have their own representative checks. Approve all may emit no approval requests, so this scenario does not fabricate an approval callback.

The check image defaults to the product's `node:22-bookworm`, pulled only by the owned engine. Override it with `ENOUGHFACTORY_SMOKE_CHECK_IMAGE` for another suitable image with Bash, Git and standard shell utilities. The script does not borrow cached images from another daemon. `ENOUGHFACTORY_SMOKE_PORT` changes the isolated port from 4327.

Set `ENOUGHFACTORY_SMOKE_FIXTURE` to an existing completed managed-runtime fixture to repeat only the final source/API assertions. This mode does not create another goal or spend inference. An older fixture without owned-endpoint readiness evidence cannot pass the current ownership check. The catalog hides provider thread IDs; authenticated conversation detail supplies the runtime-resume evidence.

The earlier coordination run exposed a session-name budget issue before inference. Factory session naming was repaired before the completed journeys below.

## Earlier coordination result, 5 October 2026

This recorded run preceded the decision to bundle an owned runtime. It proves the coordination and real-agent behavior below, rather than the new engine-ownership boundary. The current managed-runtime result follows below.

The goal completed with one planner turn, one worker attempt and one independent evaluator. The worker candidate `528d9f4ea7ef019229921d1e7eb7758eb1bf622d` was retained while paused. After a device-service restart, the same attempt ID and authority generation 1 continued and integrated exactly once at `cbb8cfc18d97af9691f8af87cac3226421f582a0`. The host repository is clean; its 16 CLI behavior checks pass. The evaluator inspected the integrated head and supplied evidence for all nine recorded completion criteria.

The restart loaded the repaired factory session naming: the evaluator ran in `factory-proof-f-19ba312bbaa1`. The first post-completion assertion mistakenly looked for provider thread IDs in the public catalog; it was corrected to use conversation detail and the already completed fixture was reverified without another model turn.

Machine-readable evidence is in [factory-smoke-evidence.json](factory-smoke-evidence.json). The retained disposable source is at `/var/folders/xx/cg7xb9kn7xn80rn6xg_td2wm0000gn/T/enoughfactory-product-cNDeG9/repository` on the current machine.

## Owned-runtime result, 5 October 2026

The [managed-runtime receipt](factory-managed-runtime-evidence.json) records a real autonomous Codex goal in a fresh application-owned Mac VM. Planner, worker, diagnosis and evaluator sessions all used its private Docker endpoint despite deliberately unusable inherited user Docker settings. The factory retained the candidate while paused, recovered it across a service update, checked it and integrated it exactly once at `371b6e36bc6e91a051da20dfcceda40706fc1c3e`. All ten retained completion criteria were satisfied at that head; 28 CLI checks passed. The fixture's service and private engine stopped cleanly afterward.

The first two attempts used an erroneous Debian slim smoke override without Git. Their actual failures are retained. That exercise exposed a misleading check diagnostic and recovery that incorrectly reclassified historical failed attempts; focused regressions now cover both corrections. The completed candidate resumed with the product's normal Git-capable check image, without discarding the earlier history. This result proves owned-runtime factory behavior; final native app archives have separate runtime, service and GUI receipts.
