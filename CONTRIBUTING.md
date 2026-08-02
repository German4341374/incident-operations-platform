# Contributing

Use Node.js 24 and install the locked dependency graph with `npm ci`. Create a focused branch, keep changes small, and run `npm run check` plus `npm run build` before opening a pull request.

Commits follow Conventional Commits, for example `feat: add acknowledgement escalation` or `fix: reject stale incident updates`. Never commit `.env`, production payloads, access tokens, or customer information. Database changes must be forward-compatible SQL migrations; an already published migration must not be edited.

Pull requests should explain operational risk, failure behavior, verification evidence, and rollback steps.
