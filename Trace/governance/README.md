# Trace publication governance

Committed real traces must be `public` with completed license, consent, privacy,
and sanitization evidence. New imports remain ignored under `Trace/real/.private/`
until that review is complete.

`legacy-tracked` is a temporary compatibility state for fixtures that predate
the publication contract. Every such case requires an entry in
`legacy-publication-exceptions.json` with an owner, reason, review deadline, and
disposition. `npm run trace:validate` fails for missing, duplicate, stale, or
expired exceptions. An exception does not grant publication approval: by its
deadline the owner must complete the review or quarantine/remove the fixture.
