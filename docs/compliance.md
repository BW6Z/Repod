# Competition compliance tracker

The official rules have **not** been reviewed yet. Nothing in this repository
claims compliance until each item below is checked against the official
source.

## 1. Verified official requirements

Official rules, submission requirements and judging criteria have not been
read yet.

From the official "Meta Global AI Hackathon: Model API Credit Claims" form
(a hackathon communication, not the competition rules):

- Each accepted participant can claim $150 in Meta Model API credits, once,
  for their own account.
- The account needs a payment method on file before the first API call.
- Claims close Wed 2026-11-04 at 21:00 ET; credits arrive within 2 business
  days of the claim.

## 2. Current implementation decisions

- The coordinator is a Meta model (enforced by config validation).
- Meta models are called through the Meta Model API (`https://api.meta.ai/v1`).
- The main (coordinating) AI is always a Meta model; config validation
  rejects any other coordinator.
- Executors may come from other providers, including free-tier models, for
  simple reading and writing tasks. The shipped presets currently use Meta
  models only: `muse-spark-1.3` (coordinator, routine work) and
  `muse-wonder-1.0` (critical work, review), which keeps spend on the
  hackathon credits. Non-Meta executors will not appear in the final demo
  until the official rules confirm they are allowed.
- Claude and OpenAI models are only reachable through API keys; consumer
  subscriptions are not used as a model source.
- Contributor-mode models are not used.
- Responses are requested with `store: false`.
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
