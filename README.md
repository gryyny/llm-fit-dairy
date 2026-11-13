# Food diary

A food diary for ChatGPT, with an authenticated MCP service and a read-only website. Chat handles food recognition, estimates and calculations; the service stores supplied facts and preserves ownership, provenance and history.

The implementation includes:

- Google and email/password sign-in, OAuth with PKCE, explicit consent, independent profiles and revocable ChatGPT connections.
- Meals, reusable foods and recipes, optional body context, dated weights and agreed nutrition targets.
- Shared food identities with immutable revisions and separate personal library links. Historical meals retain their saved values.
- Ciqual, BLS, USDA and Open Food Facts importers, source-preserving catalogue search and GTIN matching.
- An English/Ukrainian website for Today, History, Foods, Body and account settings. Diary data is entered and corrected in chat.

## Project status

The API, website and plugin package are implemented. Local and CI checks cover authentication, profile isolation, migrations, retries, concurrency, source fidelity and website behavior. Complete published-plugin and physical iPhone acceptance remain separate live checks; see the [verification register](docs/research.md#verification-register).

Publishing this source does not publish the ChatGPT plugin or grant access to a hosted diary. Deployment and plugin distribution require their own configuration and authorization. Private operational records and credentials do not belong in this repository.

## Development

Use Node `^22.22.2 || ^24.15.0 || >=26` and pnpm 10.28.0:

```sh
corepack enable
pnpm install --frozen-lockfile
```

`pnpm check` runs formatting, ESLint, typechecking, unused-code checks, tests and both production builds. API integration tests require a dedicated PostgreSQL 16 database; **the test setup drops and recreates its schemas**. Set `TEST_DATABASE_URL` to a disposable test database before running the gate. See [AGENTS.md](AGENTS.md#commands) for commands and database requirements.

For a local application stack, copy `.env.example` to `.env`, supply your own configuration and protected Firebase service-account file, then run `docker compose up -d --build`. Keep real configuration, imported archives, browser authentication state and database backups out of Git.

## Further reading

| Document | Purpose |
| --- | --- |
| [Product spec](docs/product-spec.md) | Required behavior, scope and acceptance criteria. |
| [Implementation plan](docs/implementation-plan.md) | Technical contracts and verification boundaries. |
| [Research](docs/research.md) | Dated source evidence, dependency triage and test status. |
| [AGENTS.md](AGENTS.md) | Repository conventions and verification commands. |
| [Operations guidance](.agents/skills/contabo-ops/SKILL.md) | Generic safeguards for separately authorized infrastructure work. |

The workspace contains `apps/api` (NestJS, PostgreSQL, MCP and importers), `apps/web` (React and Vite), and `chatgpt/plugin` (package metadata and diary instructions). The closed packaging probe remains under `probes/` as a credential-free historical fixture.
