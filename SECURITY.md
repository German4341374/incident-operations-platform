# Security Policy

Do not open public issues containing vulnerabilities, credentials, incident payloads, or customer data. Use GitHub's private vulnerability reporting for this repository.

This demonstration has no authentication or authorization layer. Run it only on a developer workstation or behind an authenticated reverse proxy and trusted network. Replace all example passwords before any shared deployment. Redis and PostgreSQL are intentionally not published to the host by Docker Compose.

Supported security fixes target the current `main` branch. Reports should include affected versions, impact, reproduction steps, and suggested mitigations without real sensitive data.
