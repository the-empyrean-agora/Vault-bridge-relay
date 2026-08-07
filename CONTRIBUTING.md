# Contributing

This is a personal project shared as-is. Issues and PRs are welcome, but a response isn't guaranteed — an open issue sitting unanswered is normal here, not a snub.

- Contributions are accepted under the MIT licence (inbound = outbound). No CLA.
- If you're contributing from a work account, make sure you're entitled to — code written for an employer may belong to them.
- The MCP tool surface must stay in parity across relay mode and R2 mode: a tool change touches the Worker, the Python client, and both test suites.
- Before submitting: `cd relay && npx tsc --noEmit && npx vitest run` (and `cd client && python -m pytest tests/ -v` if you touched the Python client).
