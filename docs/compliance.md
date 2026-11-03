# Competition compliance tracker

Sources of the verified items below:

- the official **Meta Global AI Developer Hackathon Participant Guide**
  (Cerebral Valley), read on 2026-11-01;
- the public event page, `cerebralvalley.ai/e/meta-ai-developer-hackathon`,
  read again on 2026-11-03;
- the **Official Rules**: "Hackathon Terms & Conditions ("Official Rules")
  and Event Waiver", linked from the event page as "View Application
  Overview and Event Waiver" (`.../meta-ai-developer-hackathon/waiver`),
  read on 2026-11-03.

The **Credit Terms** PDF linked from the Official Rules could not be read
(its signed link had expired). This is not a claim of full compliance.

## 1. Verified official requirements

### From the Official Rules

- **Models:** participants build with Meta AI products, "including Muse
  Spark, Glimmer, SAM 3", and any other Meta AI products named on the
  event page. The rules neither forbid nor explicitly allow models from
  other companies.
- **Credits:** selected participants receive $150 in Meta Model API
  credits, valid for a 10-day development window, subject to the Credit
  Terms (not read).
- **Judging criteria** for submitted projects:
  - **Impact (30%):** real-world potential, who benefits, how much it
    matters, whether people could use it, and fit with a problem statement.
  - **Use of Meta AI Tooling (25%):** how creatively Meta's tooling is used,
    whether it goes beyond a basic integration, and whether it surfaces
    unexpected capabilities.
  - **Technical Depth & Execution (20%):** sound, refined engineering that
    shows real craft.
  - **Demo (25%):** a working, impressive demo that holds up live, and the
    quality of the demo video.
- **Tracks:** two; a participant applies for one and a project enters one.
  - Indie Developer: individual builders and students, teams of up to four.
    A Representative submits and names every other team member.
  - Startup: technical founders; the Representative must be an active
    employee of the startup.
- **Representative:** acts for the team and warrants that every member has
  read and agrees to the Official Rules.
- **Submission:** through the Cerebral Valley portal
  (`.../meta-ai-developer-hackathon/hackathon/submit`).
- **Original work:** the submission must be the team's own original work,
  owned solely by the team, and must not infringe anyone's rights.
  - Open-source software may be included if its licenses are followed and
    the submission builds on it.
  - Third-party technical help is allowed if the submission's components
    remain the team's own work.
- **Licence to the Organizers:** the team keeps ownership but grants the
  Organizers a perpetual, irrevocable, worldwide, royalty-free,
  non-exclusive licence to use the submission, including in marketing.
  Materials shared during the event are not confidential.
- **Eligibility** (per person, checked before any prize is paid):
  - at least 18 and of the age of majority where the participant lives;
  - not located in a country whose law prohibits participation, and not
    covered by the sanctions and country list in the rules;
  - not an employee, contractor or intern of Meta or Cerebral Valley,
    government-affiliated, or a family or household member of such a
    person.
- **Prizes:**
  - Indie Developer: $400,000 in total, from $150,000 for 1st to $25,000
    for 5th.
  - Startup: $550,000 in total, from $250,000 for 1st to $25,000 for 5th.
  - Bonus prizes: up to $50,000.
  - Winners provide a W-9 or W-8BEN and pay their own taxes and fees.
- **Conduct:** the Organizers may disqualify disruptive or abusive
  participants and may change these terms.

### From the event page

- **Dates:**
  - building from Oct 26 (kickoff) to Nov 4;
  - submissions due Nov 4, 9:00 PM ET;
  - judging Nov 4 to Nov 8;
  - finals and winners on Nov 9.
- **Models named:**
  - through the Meta Model API: the Muse Spark series, Muse Wonder, Muse
    Image and SAM 3.1;
  - Meta's open-weights models;
  - the Muse Code coding agent.
- **Inference partners:** each offers credits to "select participants" for
  Meta's open-weights models. How to claim them is not stated on the page.
  - Baseten: $100 and 2M TPM rate limits.
  - Modal: $100, through Endpoints.
  - Fireworks: $100.

### From the Participant Guide

- **Theme:** the project must build towards one of two problem statements,
  "Build for Your World" or "Push the Frontier" (challenges in software,
  robotics and other fields).
- **Meta models:** the project must incorporate Meta's models.
  - Through the Meta Model API: Muse Spark series, Muse Wonder, Muse Image,
    Muse Voice Transcribe and SAM 3.1.
  - Open-weight: Muse Glimmer and Muse Spark Open.
  - The Muse Code coding agent.
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
- **Judging stages:**
  - Stage one is pass/fail: the project reasonably fits the theme and
    reasonably used the Meta Model API and/or Meta's open-weight models to
    build the project during the Hackathon.
  - Stage two scores 0-10 on a rubric. The guide's own rubric table was not
    read; the Official Rules give the criteria and weights above.
  - Stage three: top 5 per track, judged live from the videos.
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
  used. The Official Rules do not forbid other models, but they do not
  confirm them either, so the deadline build stays Meta-only.
- No preset uses Meta's open-weight models (Muse Spark Open, Muse Glimmer)
  or a partner host yet. That would be the fallback if the Meta Model API
  credits are not available: the partner credits cover exactly those
  models, and the guide's stage-one wording accepts them.
- Claude and OpenAI models are only reachable through API keys; consumer
  subscriptions are not used as a model source. Contributor-mode models are
  not used. Responses are requested with `store: false`.
- The repository `BW6Z/Repod` is public. Its first commit is dated
  2026-10-30, inside the building period; all code in it was written during
  the Hackathon.
- Dependencies: `zod` (MIT), `typescript` and `@types/node` (dev only).
  The Official Rules allow open-source software whose licenses are
  followed. The sample repository and tests were written for this project.
- The demo and video must show only this repository's work and say so.
- The repository is licensed MIT (`LICENSE`, copyright BW6Z). The rules
  require a public repository and grant the Organizers their own licence,
  but do not require a particular open-source license.

## 3. Unverified assumptions and open questions

- The Credit Terms (Meta Model API credits) have not been read.
- How to claim the Baseten, Modal and Fireworks credits, and whether this
  team was selected for them.
- Whether those hosts serve Muse Spark Open and Muse Glimmer through an
  OpenAI-style `/responses` endpoint with strict JSON-schema output, which
  the Meta adapter relies on. This has not been tried.
- Whether non-Meta model APIs (such as Anthropic) are acceptable alongside
  Meta's models: neither forbidden nor confirmed.
- Whether calling Meta's closed models (Muse Spark 1.3, Muse Wonder)
  through a third-party router such as OpenRouter counts as use of the Meta
  Model API. Not addressed by the rules.
- Which track to enter (Indie Developer or Startup), the team members, and
  each member's eligibility are not decided or checked here.
- Whether judges need a hosted "live product". The Official Rules score
  whether the demo "holds up live" but do not require hosting; a CLI and
  local page with a recorded video may score lower on Demo.
