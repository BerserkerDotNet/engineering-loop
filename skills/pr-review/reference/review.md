# Review session contract

Read this file for Phases 3-5 and recovery.

## Models and child launch

| Role | Area tag | Model |
|---|---|---|
| Security | `[Security]` | `gpt-5.6-sol` |
| Design | `[Design]` | `claude-opus-5` |
| Canonical | `[Canonical]` | `gemini-3.1-pro-preview` |
| Performance | `[Performance]` | `gpt-5.6-sol` |
| Explorer | not an area | `claude-opus-5` |

Security, Design, Canonical, and Performance are the minimum review set and may not be omitted.
After inspecting the bundle and codebase context, the coordinator may add one or more specialist
topic reviews when the change warrants them, such as compatibility, data migration, concurrency,
accessibility, localization, API contracts, or domain-specific correctness. Record each
additional topic, why it is needed, its exact scope, and an explicit model selected for that
topic before launch. The selected model is fixed for that review; never use a default or silently
substitute it. Additional reviews use `[<Topic>]` findings and the same evidence, isolation,
budget, delivery, and replacement rules as the baseline set.

Pass every model in `kickoff.model`; never substitute. A missing model blocks. Reuse one session
per role; exactly one recorded same-model replacement is allowed, then the run blocks.

Create each child with the target `project_id`, `execution_location: "local"`,
`coordinate_with_creator: true`, `notify_on_idle: "always"`, and an autopilot kickoff carrying
`COORDINATOR_SESSION_ID`, `RUN_ID`, `PHASE`, monotonic `SEQUENCE`, isolated bundle path,
`bundle_digest`, `access_digest`, and `review_digest`. Children read only the bundle and never
ask the user directly. `review_digest` hashes role, model, prompt version, bundle, and access.

Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at
100 per role. Overflow blocks rather than truncates. Bundle files are read in bounded chunks.

Read `../prompts/area-review.md` before launching reviewers. Require `REVIEW_COMPLETE` with
attested digests and either `[<Area>] <Text>` findings with bundle path and blob SHA-256
citations or explicit no violations. `NEEDS_CONTEXT` and `BLOCKED` are the only other outcomes.
All four baseline areas and every additional launched topic must complete.

## Reconciliation and exploration

Verify session, sequence, `bundle_digest`, `access_digest`, and `review_digest`; reject stale
envelopes and re-verify the bundle. Present the pinned revision, short change summary, codebase
fit, all attributed findings/citations/corrections, and explicit no-violation areas. Deduplicate
without dropping distinct claims.

Read `../prompts/exploration.md` only when exploration begins. The explorer is advisory: it
answers cross-area questions from the bundle, cannot mutate findings or drafts, and routes new
area claims to the owning reviewer. It is superseded on drift.

All child interaction reaches the user through the coordinator. Only user-authored or explicitly
adopted comments enter the pending set; a finding that the user did not adopt is never pending.
Every draft mutation creates a new semantic set digest.

## Vocabulary and delivery

| Kind | Terms |
|---|---|
| Child envelopes | `REVIEW_COMPLETE`, `EXPLORATION_COMPLETE`, `NEEDS_CONTEXT`, `BLOCKED` |
| Coordinator commands | `CONTEXT_GRANTED`, `CONTEXT_DENIED`, `REFRESH_REVIEW`, `SUPERSEDE`, `SET_APPROVED` |
| Run states | `access`, `acquiring`, `reviewing`, `reconciling`, `composing`, `previewed`, `deferred`, `approved`, `revalidating`, `posting`, `complete`, `blocked`, `stale` |
| Item states | `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, `uncertain` |

Children echo `RUN_ID`, `PHASE`, and `SEQUENCE`, deliver each requested terminal envelope exactly
once through `send_session_message`, treat successful tool return as delivery, then emit only
`Delivered <STATUS> to coordinator.` locally. Accept only the expected session, status, sequence,
and digests.

## Ledger and recovery

Use session SQL when available, otherwise coordinator context. Preserve run/locator/immutable
IDs, pinned revisions, adapter/access/certification data, bundle and review digests, child
sessions/models/outcomes, drafts and approved set, lease owner/epoch, and item/provider IDs.
Never rely on child session names.

- Lost child with no mutation: create the one allowed same-model replacement.
- Bundle verification failure: discard affected reviews, reseal, and refresh.
- Lost coordinator: block posting; reconstruct from journal, lease, and fresh inventory, then
  require a fresh preview and approval.
- Denied lease: report holder run/epoch and do not write.
- Reuse ledger-recorded child sessions; never duplicate them on retry.
- Respect repository instructions and finalized tests.
