# App quality and inspection acceptance

EnoughFactory must inspect and improve the product users will actually run. Compilation, accepted task counts and a feature inventory cannot establish that its interface works or looks good. The quality loop is: inspect the real reference, run the current product, observe, act, verify, critique, repair and repeat.

## Product integration

`apps/device/src/factory-quality.ts` supplies compact worker, planner, evaluator and diagnosis instructions. Append the corresponding `factoryQualityInstructions(role)` to worker and controller system instructions in `apps/device/src/factory.ts`. Keep capability availability in the separately supplied inventory; these instructions do not claim a browser, native runner or reference exists.

For a task with material user-facing behavior, the coordinator supplies an explicit `QualityExpectation`: current inspection authority, the immutable source identity (including additional roots), required platforms, representative workflow IDs and inspected reference IDs. Do not guess this contract from task titles or impose a whole-product screenshot suite on architecture/backend work. Final delivery reviews the integrated source; candidate and integration identities remain distinct.

The author retains a bounded `QualityEvidenceReport` as an artifact. Its workflow entries identify a screenshot before an action, the action and a screenshot after it, with a concrete observed assertion. Each passed workflow also supplies the original `assertionEvidenceId` returned by the broker's assertion tool on that resulting observation. The service verifies the original passed assertion and its bytes; authored prose alone cannot satisfy it. Its visual reviews compare the supplied reference and cover hierarchy, spacing, clipping, typography, controls and states. Serious unresolved defects require focused repairs. A small issue can be recorded without becoming a new approval ceremony.

`validateQualityEvidence()` resolves report references through the service's trusted journals. The resolver must verify retained screenshot bytes against ArtifactStore manifests, read original broker action/observation records, confirm the source and authority, and read a provider image-delivery record. An authored report cannot create those receipts. An image-delivery record is written only when actual screenshot content reaches the provider through its tested tool/image route, or a verified image-view completion; merely staging a file or including image-shaped tool arguments is insufficient. Broker observations/actions require monotonic session sequence numbers and a successful original observing action; a stale observation, failed snapshot, unknown action outcome or different session cannot establish a workflow result.

An inspected reference receipt pins the original artifact manifests and verified bytes, rather than looking up whatever content currently has an artifact ID. Reference images also require real provider image delivery. A newer valid reference inspection can recover from an older unavailable view. The service fences trusted journal changes across asynchronous artifact verification so that a new failed report or unknown backend outcome cannot race an acceptance result.

The result distinguishes missing evidence, observed repair work and evidence ready for review. This is a provenance/coverage gate, not an automatic beauty score. The evaluator must still see the images and judge whether the comparisons and assertions are true. Retain the report and original evidence with the accepted result. A resolver error or corrupted artifact must remain missing/invalid evidence rather than success.

`factoryQualityEvidenceContext()` formats a bounded selection of current-source screenshot references and optional UI excerpts for a controller or continuation. It preserves separate observation, evidence and artifact IDs and explicitly states that metadata contains no image bytes. The provider's image route supplies the actual images separately. Action `observationId` is compared with the original UI observation identity, not its screenshot artifact ID.

`InspectionQualityService` in `apps/device/src/inspection-quality.ts` resolves the original SQLite inspection/provider journals, verifies the image and report bytes through ArtifactStore, saves submitted reports, and supplies the enforced `enoughfactory:ui-quality` check. The frozen task `quality` policy selects the required platforms, workflows and reference IDs. Both the saved candidate and the actual combined integration source must pass this check. A preview's synthetic Git commit is never relabeled as a candidate or integration commit: exact aggregate and per-root content digest equivalence gets its own retained receipt containing both identities. Changed source or secondary roots require fresh matching inspection evidence.

Missing inspection evidence produces a persisted verifier wait that preserves the existing author attempt and candidate. A genuine failed broker assertion, reported workflow failure or open serious visual defect requests repair. Resuming evidence collection must not create a fresh author attempt or repeatedly retry an unavailable native capability.

Independent verification receives the original frozen task description, acceptance criteria and expected outputs. Final product verification also receives the current goal's objective and completion criteria, plus the frozen contracts of accepted tasks contributing UI quality requirements. Large contracts use bounded original-content reads with complete range coverage; workflow names cannot replace their requirements. Full text restoration requires exact observed-value assertions on the required populated flow, including every specified field and restart transition.

New reports, reference reads and image deliveries are bound to the current verifier run, conversation and acceptance contract digest. Historical reports remain retained, but cannot satisfy a new contract-aware review. A still-active or uncertain older verifier must settle before a new reviewer starts. A source audit that rejects the current fixture becomes a failed check with its original findings, allowing repair without waiting indefinitely for GUI readiness.

Independent reviewers can inspect original same-goal history through `factory_verification_history`, `factory_verification_evidence` and `factory_verification_image`. Access is limited to the current frozen contract's author and accepted task attempts. Original screenshots, action chronology, check/result records and base-to-candidate diffs keep their source, authority and artifact hashes. Historical reads and image deliveries have separate journals; even identical historical and current pixels cannot make a historical view count as current acceptance. Missing retained bytes remain an evidence gap.

The evidence reader also exposes `author-trace`, `source-manifest` and `author-retirement`. An author trace requires the original completed result and the exact goal/task/attempt/generation/chat/session/internal-workspace owner chain. Its immutable prefix digest covers original SQLite sequence, storage time and raw event JSON through that completion. Read each text range, then advance `eventCursor` using `nextEventCursor`; each page contains at most 32 original tool events and text reads contain at most 16,000 characters. Start at cursor zero and continue until `complete`, including long chats beyond the ordinary 10,000-event UI window. Failed commands and literal ordering violations remain visible. Source manifests retain original capture times, all-root hashes and CAS provenance; original typed retirement records retain owned environment closure. These records are context only and cannot prove unrecorded or transient write absence, replace current UI evidence, or establish a server shutdown mechanism that was never recorded.

Service inspection captures the primary source and every declared project folder. A controller's generated planning archive is excluded only after its original launch artifact and exact owned mount are confirmed; unknown extra folders fail capture. The service uses a consistent 512 MiB aggregate source limit through capture, transfer, verification and preservation. Generic snapshot defaults remain unchanged. Supplied reference evidence is retained rather than silently filtered to fit a smaller limit.

Verifier recovery retains the original run, conversation, provider thread and frozen source. Provider thread identity is saved when the thread starts, before a final response exists. A service restart may resume container setup only after the original container has a verified removal receipt and the reserved conversation has no provider admission events. Native continuation requires positive termination evidence for the original provider, verified source bytes and stop-only reconciliation of its inspection sessions and builds. Reconciliation is scoped to that verifier and leaves unrelated active inspection work running. Previous unknown actions remain unknown; continuation uses fresh sessions, observations and request identities.

New host processes record a kernel boot identity. A different boot on the same machine proves the old process ended, without asserting that its turn succeeded. Missing PIDs and wall-clock timestamps alone do not prove a reboot. Older records without a boot identity remain unresolved unless an explicitly recorded operator reconciliation supplies the required termination evidence; product agents cannot manufacture this reconciliation through their inspection tools.

Before completion of a goal with explicit UI acceptance, `InspectionQualityService.reviewCheck()` requires a separate evaluator's own real image deliveries and original reference reads. The evaluator returns `visualReview: {source,reviews}` using the report's visual review shape. The factory supplies the trusted current integrated source; authored identity alone cannot select it. Every reviewed screenshot must retain its original successful observation and match all current source/root digests. Old controllers, author image deliveries, changed reference manifests, unknown outcomes and an empty or incomplete critique cannot substitute for this review. Open serious defects refuse completion and remain actionable repair work.

The final evaluator also reads each required workflow's original resulting assertion through `factory_review_evidence`. Its read receipt pins the exact artifact and integrated source. The service revalidates the latest current-authority report for every relevant workflow policy; an older passing report cannot mask a newer failure. Superseded author attempts do not permanently poison a later repaired result. Reports and evaluator reads participate in the acceptance fence, so a failure arriving during verification cannot race completion.

An honest incomplete evaluation can request the missing independent verification of the integrated commit without replaying its accepted author. A concrete repair plan still returns to planning. Source identities retain full permission bits: before evaluation, the service may materialize canonical modes in its private controller copy only after proving all bytes, paths and symlink targets match, retaining the original source in CAS and checking the canonical project again. Historical source identities are never relabeled to make their evidence current.

`factory_review_screens` supplies bounded, original-verified quality report summaries with workflow and assertion IDs, current-source and current-authority markers, and explicit omitted counts. `factory_review_evidence` also accepts a quality report ID to return its original JSON. A retained recorded gate status is historical context; final verification checks the evidence again. The final source comes from the owning canonical project and all declared roots. A changed or reverted private evaluator checkout cannot substitute for that source, and a canonical change during review invalidates acceptance. Platform-only policies still validate their latest reports and cannot hide an open serious visual defect behind an empty workflow list.

Browser assertions parse the pinned Playwright MCP `Snapshot` section, with the older `Page Snapshot` spelling also supported. Console logs and generated code are excluded. Since snapshots can flatten multiline input text, exact editable values come from fixed service-owned, read-only DOM queries against the original snapshot references in the owned browser. These reads retain their original results and source/action/observation bindings; they preserve line breaks and exclude secure values. A changed tab or document invalidates the observation. Missing exact field reads cannot fall back to flattened snapshot values. Unsupported or incomplete snapshot syntax, failed refreshes and silently omitted control names cannot establish absence. Native restart is a journaled, acknowledged workflow action and can establish draft persistence through its resulting observation. Exact read-only native fields use observed label equality; editable fields use observed value equality.

## EnoughMail pilot

The current web reference is the EnoughMail UI in the supplied `mail-web` working folder. In this development checkout its source is `forms/open-cloud/apps/mail/src/ui`: `MailApp.tsx`, `MailFrame.tsx`, `mailbox.css`, `Compose.tsx` and `Settings.tsx`. The actual library is the pinned EnoughUI source, with the native package vendored under `Vendor/EnoughUI` in the mail repository. Record the exact mounted reference identity used by the run; these local paths do not promise that future workers have them. Source inspection identifies intended flows; browser screenshots and exercised behavior establish the current web UX.

Source-backed design cues to verify against actual screens:

- A persistent navigation rail and an inbox/list/reader hierarchy leave most of the window for mail. Search, filtering and bulk actions stay compact. Subject, sender, preview and date use deliberate hierarchy rather than equally large controls.
- EnoughUI supplies real buttons, inputs, menus, tooltips, spinners and empty states. Reuse its tokens and component behavior; an imported library that is bypassed by hand-built controls is not design-system adherence.
- The web reader has focused reply/reply-all/forward actions and secondary conversation actions in a menu. Composition preserves the reading context and provides a clear way back to mail. Draft recovery, interrupted sends and offline recovery expose understandable state and actions.
- Comfortable padding and usable scrolling are intentional. Check sidebar labels, reader content, composer fields and bottom actions at narrow and normal widths. Fix clipped or inaccessible content without shrinking every control or removing all insets.
- Settings and infrequent administrative features live away from the primary mail reading/writing flow. Keyboard shortcuts pause while typing; visible focus belongs to the actual interactive control.

Start with the observed draft-close defect on both macOS and the owned iPhone Simulator:

1. Open a fixture message, choose Reply, edit the body and observe its saved state.
2. Choose Close and keep draft. Observe that composition actually disappears and the inbox/reader returns.
3. Reopen the retained draft and assert its sender, recipients, subject and edited body.
4. Restart the isolated app session and reopen that draft again; assert persistence from the app UI.
5. Capture inbox/reader/composer screens at representative sizes, compare them to the actual EnoughMail web reference and EnoughUI, repair visible defects and inspect the rebuilt source again.

These journeys prove the new development loop and fix concrete problems. They do not replace the user's original feature, offline, live-service, native-build or distribution criteria. Keep fixture success separate from authenticated service and signing results; a missing credential is a concrete prerequisite, not a reason to claim the whole application complete.

## First native profile setup

A new app can set up testing through the normal Factory tools. `factory_native_profile_propose` freezes the complete current source and all declared roots, a fixed Xcode build recipe, exact fixture launch arguments with a unique `{runId}`, and source-file starting points for entry, storage, credentials, providers, preferences, notifications and build behavior. On Mac the fixture root must be `/tmp/enoughfactory-fixtures/{runId}` (or its canonical `/private/tmp` spelling). iOS uses a fresh owned Simulator and its app sandbox; a host temporary path is not an iOS storage guarantee.

The service queues a separate pinned Codex source reviewer. It provides the full immutable file inventory and original byte reads, so author-selected paths cannot hide production constructors or dependencies. The reviewer follows the reachable initialization graph and build phases. Requested fixture mode must route before production constructors and reject incomplete fixture invocations; ordinary user launch without fixture mode may still use production behavior. This is recorded source judgment, not a formal runtime isolation proof or UI acceptance. Exact read artifacts, judgment and the original all-root source manifest accompany the service-issued receipt. Any source or mode change requires another audit; automatic profiles have no editable exceptions.

Enough owns policy and continuation. Approve all runs setup automatically; rules/manual use the durable native fixture setup action in Approvals. The reviewer counts toward the goal's configured agent limit. At a limit of one, the author leaves source unchanged and ends its turn, Factory retains the exact candidate, runs the queued audit, then continues verification of that same candidate and chat. Restart, pause and unknown provider outcomes keep the original owners and reconcile termination before replay. Completed audit workspaces and containers retire after source, chat and useful artifacts are durable.

A Linux coordinator can run this source-only review and transfer its original audit, reads, receipt and frozen source over an authenticated pairing to the Mac owner. Build, launch, runtime data isolation, actual screenshot delivery, workflow assertions and visual review remain separately gated on that Mac. First-profile setup does not claim native success when Apple tools, desktop access or genuine quality evidence are unavailable.

## Compact report shape

```json
{
  "version": 1,
  "source": { "snapshotId": "from-broker", "sha256": "original-snapshot-sha256" },
  "workflows": [{
    "id": "close-and-keep-draft", "platform": "macos",
    "before": "screenshot-evidence-id", "action": "action-id", "after": "screenshot-evidence-id",
    "outcome": "passed", "assertion": "Composer is absent; the inbox is visible.",
    "assertionEvidenceId": "original-broker-assertion-evidence-id"
  }],
  "reviews": [{
    "platform": "macos", "observations": ["screenshot-evidence-id"],
    "references": [{ "id": "mail-web", "comparison": "Concrete observed comparison" }],
    "dimensions": {
      "hierarchy": "Observed finding", "spacing": "Observed finding", "clipping": "Observed finding",
      "typography": "Observed finding", "controls": "Observed finding", "states": "Observed finding"
    },
    "defects": []
  }]
}
```

Use the complete broker source identity, not the abbreviated example. Keep only selected useful checkpoints and failure images. Do not duplicate base64 images into reports or chat history, generate hundreds of nominal scenarios for a small repair, or make the user interpret internal planning JSON as the product's result.
