# Competition compliance tracker

Source of the verified items below: the official **Meta Global AI Developer
Hackathon Participant Guide** (Cerebral Valley), read on 2026-11-01, and the
public event page. The rubric table and the separate Official Rules document
have **not** been read yet, so this is not a claim of full compliance.

## 1. Verified official requirements

From the Participant Guide:

- **Theme:** the project must build towards one of two problem statements,
  "Build for Your World" or "Push the Frontier" (challenges in software,
  robotics and other fields).
- **Meta models:** the project must incorporate Meta's models. Named
  options: Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe
  and SAM 3.1 through the Meta Model API; the open-weight models Muse
  Glimmer and Muse Spark Open; the Muse Code coding agent.
- **Public repository:** repositories must be public.
- **Team size:** at most four; solo participants are allowed.
- **New work only:** what is presented must have been built during the
  event (building period Oct 27 - Nov 4), and this must be clear in the
  submission.
- **Demo:** the demo must only highlight features, code and functionality
  built during the Hackathon; judges must be able to tell what was created
  during it. Failing to identify original contributions can mean
  disqualification.
- **Rights:** projects using code, data or assets the team has no rights
  to, or violating legal, ethical or platform policies, are disqualified.
  The guide lists generic "anti-projects" to avoid (medical advice, basic
  RAG, simple image analyzers, education chatbots, job screeners, nutrition
  coaches, personality or sports analyzers, anything political or about
  war).
- **Submission:** one project per team via the Cerebral Valley submit page,
  by **Wed 2026-11-04, 9:00 PM ET**; late submissions are not considered.
  One Representative submits. The repository and video link must be
  publicly accessible, and everyone who worked on the project must be
  listed.
- **Video:** a three-minute demo video of the features built during the
  Hackathon. Judges use it as a primary artifact, together with the code
  and the live product.
- **Judging:** stage one is pass/fail: the project reasonably fits the
  theme and reasonably used the Meta Model API and/or Meta's open-weight
  models to build the project during the Hackathon. Stage two scores 0-10
  on a rubric (table not read yet). Stage three: top 5 per track, judged
  live from the videos.
- **Tracks** (event page): Indie developer (individuals and students;
  judged on creativity, technical ambition and whether it works) and
  Startup (judged on technical execution and whether it holds up in
  production). Every project enters one track.
- **Credits:** each participant can claim $150 in Meta Model API credits,
  individually, by 2026-11-04 9:00 PM ET. A credit card must be on the
  account before any API call; a spend-limit notification can be set on
  the Billing page.

## 2. Current implementation decisions

- Theme: "Push the Frontier" (software): a Meta model coordinates a
  development request and routes the work.
- The coordinator is a Meta model (enforced by config validation). The
  shipped presets use only Meta models through the Meta Model API
  (`https://api.meta.ai/v1`): `muse-spark-1.3` (coordinator, routine work)
  and `muse-wonder-1.0` (critical work, review). Both are named options in
  the guide.
- Executors could come from other providers through adapters, but none is
  used: the guide does not forbid other models, and it does not confirm
  them either, so the deadline build stays Meta-only.
- Claude and OpenAI models are only reachable through API keys; consumer
  subscriptions are not used as a model source. Contributor-mode models are
  not used. Responses are requested with `store: false`.
- The repository `BW6Z/Repod` is public. Its first commit is dated
  2026-10-30, inside the building period; all code in it was written during
  the Hackathon.
- Dependencies: `zod` (MIT), `typescript` and `@types/node` (dev only).
  The sample repository and tests were written for this project.
- The demo and video must show only this repository's work and say so.

## 3. Unverified assumptions and open questions

- The judging rubric (stage two criteria and weights) and the prize tables
  were not part of the copy read.
- The separate Official Rules document has not been read.
- Which track to enter (Indie developer or Startup) and the team members
  are not decided here.
- Whether judges expect a hosted "live product" or accept a CLI with a
  recorded demo; the guide mentions the live product as a judging artifact
  but does not state it as a requirement.
- Whether non-Meta model APIs (such as Anthropic) are permitted alongside
  Meta's models.
- The repository has no license file; the guide requires a public
  repository but does not name a license.
