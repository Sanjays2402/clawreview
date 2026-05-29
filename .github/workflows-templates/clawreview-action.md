# ClawReview GitHub Action snippet

The hosted GitHub App is the recommended install path. If you cannot install
an App across an org, the following reusable workflow runs the CLI against
each PR using a self-hosted runner:

\`\`\`yaml
name: clawreview
on:
  pull_request:
    branches: [main]
jobs:
  review:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm cli -- run --base \${{ github.base_ref }} --head \${{ github.head_ref }} --format json
\`\`\`
