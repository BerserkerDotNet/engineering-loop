# <Issue Title> — Root Cause Analysis

**Status:** Proposed
**Issue:** `<issue-id-and-slug>`
**Last updated:** `<YYYY-MM-DD>`

## Symptom

State the observable, user-visible wrong behavior in one short paragraph: what happens, who
it affects, and how often. Do not state the fix.

## Reproduction and evidence

| Element | Detail |
|---|---|
| Environment | <build, version, platform, configuration> |
| Preconditions | <starting state, data, permissions> |
| Actions | <ordered steps or request> |
| Input | <concrete values> |
| Expected | <expected result> |
| Actual | <observed result, exact error or output> |
| Reproducibility | <always, intermittent with rate, or once> |

| Evidence ID | Source | Collected | Observation |
|---|---|---|---|
| EV1 | <user-supplied, repository, or executed command> | <timestamp> | <what it shows, redacted> |

Record whether the baseline was executed here and with what command and result. Summaries
only; no raw dumps. Redact secrets, tokens, authorization headers, cookies, connection
strings, personal or customer identifiers, and local paths.

## Root cause

Name the underlying defect and why it produces the symptom. If several independent causes
contribute, name each separately and keep them distinguishable.

| Claim | Evidence IDs | Observation or inference |
|---|---|---|
| <claim> | <EV IDs> | <observation \| inference> |

Also record what was considered and eliminated, and the evidence that eliminated it.

## Affected runtime paths

| Entry point | Path to the defect | Same defect present? | Evidence |
|---|---|---|---|
| <event, API, CLI, or UI action> | <code path and symbols> | <yes/no> | <EV IDs or file:symbol> |

Include shared helpers, duplicated logic, fallback and lazy-initialization paths, and tests
that currently assert the wrong behavior.

## Confidence and open risks

**Confidence:** `<high | medium | low>` — <evidence that justifies this level>

- <unresolved risk, unknown, or condition that would invalidate this cause>

No fix design, no code, and no unanswered questions belong in this artifact.
