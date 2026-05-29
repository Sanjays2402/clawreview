# Logging

Pino with JSON output by default, pretty in development. Every line has a
`requestId` for HTTP traffic and a `reviewId` for worker output.
Redaction strips `authorization`, `cookie`, GitHub signatures, and any
field named `privateKey`, `webhookSecret`, or `apiKey`.
