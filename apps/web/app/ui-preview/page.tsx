import { notFound } from "next/navigation";
import { Inbox, Plus } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  Spinner,
} from "@/components/ui";

/**
 * Dev-only page to eyeball the shared UI primitives against the Design.md tokens.
 *
 * Returns 404 in production. `middleware.ts` would also bounce it (no role has
 * access), but a build-time gate means it cannot be reached even if the guard
 * config changes.
 */
export default function UiPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <UiPreview />;
}

function UiPreview() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <header className="mb-10">
        <p className="text-xs font-medium uppercase tracking-widest text-text-secondary">
          Dev only — temporary
        </p>
        <h1 className="text-2xl font-semibold">UI Primitives</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Visual reference for the shared components in components/ui.
        </p>
      </header>

      <div className="flex flex-col gap-10">
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Buttons</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="ghost">Ghost</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button disabled>
              <Spinner />
              Saving…
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Badges</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="accent">Follow-up</Badge>
            <Badge tone="success">Completed</Badge>
            <Badge tone="warning">Waiting</Badge>
            <Badge tone="critical">Critical</Badge>
            <Badge tone="info">New</Badge>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Card</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-medium">Aarav Sharma</h3>
                  <p className="text-sm text-text-secondary">Token #12 · OPD</p>
                </div>
                <Badge tone="warning">Waiting</Badge>
              </div>
              <p className="mt-3 text-sm tabular-nums text-text-secondary">
                Wait time: 14 min
              </p>
            </Card>
            <Card>
              <h3 className="text-lg font-medium">Amount due</h3>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                ₹1,24,500
              </p>
            </Card>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Inputs</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Full name" placeholder="e.g. Aarav Sharma" />
            <Input
              label="Phone number"
              placeholder="10-digit mobile"
              helperText="Used to look up existing patients."
            />
            <Input
              label="Phone number"
              defaultValue="98xxxx"
              error="Enter a valid 10-digit number."
            />
            <Input label="Disabled" placeholder="Unavailable" disabled />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Loading (skeleton)</h2>
          <Card>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Empty state</h2>
          <EmptyState
            icon={Inbox}
            title="No patients in queue yet"
            description="Registered patients will appear here as they check in."
            action={
              <Button size="sm">
                <Plus className="h-4 w-4" />
                Register patient
              </Button>
            }
          />
        </section>
      </div>
    </main>
  );
}
