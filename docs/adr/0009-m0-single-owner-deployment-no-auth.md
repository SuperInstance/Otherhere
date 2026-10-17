# M0 is a single-owner deployment with no accounts

"Each person's World lives in storage they own" is realised in M0 as: one person deploys their own Worker, DOs, and R2 bucket to their own Cloudflare account. M0 has no accounts and no auth. The only writes are OSM ingest and Bundle builds, both idempotent and derived from public data. Friend auth (magic links vs passkeys) is decided in M1, when the first cross-person interaction (SessionDO) appears. The leaning is passkeys with an emailed magic link as fallback/recovery.
