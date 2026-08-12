This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Weekly advance in production

The program page's "Advance to week N" button is a manual stand-in, not a scheduler. It calls the
same `POST /api/programs/[id]/advance` a real deployment would call automatically. Production would
need:

- A per-cohort weekly trigger (cron, queue consumer, or workflow scheduler) invoking that same
  route on the cohort's cadence, instead of a person clicking a button.
- Idempotency / a lock around a given `(programId, weekNumber)` so a retried or duplicate trigger
  can't double-advance a week or double-insert that week's drafts.
- Alerting on a failed advance (the route already returns 502 on a model/schema failure and 400 on
  an out-of-horizon advance) so a missed week is caught, not silently skipped.

Nothing about the approve/edit flow changes in production: drafts still land as `status: "draft"`
and still require a human to approve or edit before anything happens with them — the scheduler only
replaces the button, never the approval step.

## QBR export

`/program/[id]/qbr` is a printable page. The "Print / save as PDF" button on it calls
`window.print()` — that's the entire export path. There is no PDF-generation library, no
headless-browser render, no server-side rendering pipeline: the browser's own print dialog
(and that dialog's own "Save as PDF" destination) is what produces the file. A print
stylesheet keeps the honesty banner and every `simulated` tag visible on the printed page and
hides on-screen-only controls (navigation, the Print/Regenerate buttons themselves).

The QBR is generated once, on request (`POST /api/programs/[id]/qbr`), and persisted — reloading
or printing the page does not call the model again. Cohort-level facts (completion rate, band
movement, most-improved, at-risk) are computed in code from seeded session data, exactly like the
weekly pass; the model receives those facts and writes the business-language narrative only.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
