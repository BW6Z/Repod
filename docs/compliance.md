# Competition compliance tracker

The official rules have **not** been reviewed yet. Nothing in this repository
claims compliance until each item below is checked against the official
source.

## 1. Verified official requirements

None yet. Official rules, submission requirements and judging criteria still
need to be read from the official source.

## 2. Current implementation decisions

- The coordinator is a Meta model (enforced by config validation).
- Meta models are called through the Meta Model API (`https://api.meta.ai/v1`).
- A second provider (Anthropic) is planned for strong and cheap executors;
  the final provider choice is pending.
- The repository is intended to be public.

## 3. Unverified assumptions (need confirmation)

From the project brief, not yet checked against official rules:

- A Meta model must perform substantive functionality.
- The repository must be public.
- Work shown must be new during the competition; reused code must be
  disclosed with its source.
- A publicly accessible 3-minute demo video is required.
- Teams have at most 4 members.
- Deadline: 2026-11-04, 21:00 US Eastern.

Open questions:

- Whether "Meta model" includes the Muse model family served by the Meta
  Model API.
- Whether non-Meta model APIs (such as Anthropic) are permitted.
- Whether a public product URL is required.
- Whether Contributor mode (discounted pricing in exchange for training use of
  submitted content) is acceptable.
- Judging criteria and weights.
