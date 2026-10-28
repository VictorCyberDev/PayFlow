# Authority Mark public-beta product rules

Status: product system complete locally; external public-beta adoption is not claimed.

The Gate/Authority Mark is a verification affordance, not a trust badge and never security proof by itself.

States are geometry plus language: `SUPPORTED`, `VERIFIED`, `REVOKED`, `EXPIRED`, and `UNKNOWN`. `VERIFIED` may appear only after a bound verification response. `UNKNOWN` must remain visibly unresolved. Color cannot be the sole state channel.

A verification deep link should disclose only the minimum permitted Authority/Proof material and must revalidate freshness rather than trusting a screenshot or cached browser label.

Anti-spoofing guidance: merchants should render the mark through the SDK, bind it to a verification URL they control, avoid static “verified” images, and never use the image as authorization input.
