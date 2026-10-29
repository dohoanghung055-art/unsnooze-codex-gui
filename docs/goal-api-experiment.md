# Deferred Goal API gateway experiment

This source-only experiment is not connected to the daemon or enabled in Desktop. The native launcher remains unchanged. Use the opt-in [Windows UI Automation fallback](goal-ui-resume.md) for now.

Isolated backend tests showed that two API clients can access a loaded Goal through one server, but the backend also permits automatic activation of a manually paused Goal. The owner proxy's guards and serialization therefore remain necessary. The private named-pipe WebSocket gateway reuses that proxy and passes its local regression test.

The isolated packaged Desktop launch did not connect through the supplied WebSocket override, so real Desktop lifecycle compatibility has not passed. No production API gateway has been deployed. The experiment needs a verified native Desktop connection before any activation work resumes. Unit tests do not establish that result.
