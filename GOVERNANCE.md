# Project governance

VRRelay currently uses a maintainer-led model.

Maintainers set release scope, review changes, protect architecture and security invariants, manage compatibility claims, and administer the repository. Contributors influence direction through issues, discussions, design proposals, reviews, tests, documentation, and code.

Routine fixes may be accepted through a pull request. Changes to public contracts, trust boundaries, distributed protocols, persisted schemas, default media profiles, or supported platforms should begin with a design issue so tradeoffs are visible before implementation.

Decisions favor:

1. Safety and secret isolation.
2. Reliable VRChat behavior backed by evidence.
3. Standalone usability and cloud-neutral deployment.
4. Provider-neutral, understandable boundaries.
5. Sustainable maintenance over feature count.

Compatibility status is evidence-based. A maintainer may mark a profile `verified`, `broken`, `retired`, or keep it `experimental`, but no codec or delivery method becomes a default solely because an automated FFmpeg test passes.

As the maintainer group grows, this document will be updated with nomination, voting, and succession rules.
