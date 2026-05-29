### ClawReview

🛑 1 Critical · 🔺 2 High · 🟠 3 Medium

<details><summary><code>src/users.ts</code> (1)</summary>

**🛑 Critical · sql-injection · security**
`src/users.ts:12`

SQL injection via concatenation

User input is concatenated into a raw SQL query without parameterization.

Reference: CWE-89

</details>

<details><summary><code>src/api.ts</code> (1)</summary>

**🟠 Medium · performance · performance**
`src/api.ts:3`

N+1 query in list()

Each user causes a separate database round trip. Batch with a join.

</details>

<sub>ClawReview · PR #142 · abc1234</sub>
