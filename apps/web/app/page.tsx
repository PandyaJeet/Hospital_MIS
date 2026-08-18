import Link from "next/link";

const groups: { role: string; links: { label: string; href: string }[] }[] = [
  {
    role: "Auth",
    links: [
      { label: "Login", href: "/login" },
      { label: "Onboarding", href: "/onboarding" },
    ],
  },
  {
    role: "Doctor",
    links: [
      { label: "Queue", href: "/queue" },
      { label: "Patient Chart", href: "/patient/1" },
      { label: "Prescribe", href: "/prescribe" },
      { label: "Rounds", href: "/rounds" },
    ],
  },
  {
    role: "Nurse",
    links: [
      { label: "Task Board", href: "/tasks" },
      { label: "Vitals", href: "/vitals/1" },
    ],
  },
  {
    role: "Billing",
    links: [
      { label: "Register", href: "/register" },
      { label: "Invoice", href: "/invoice/1" },
      { label: "Reconciliation", href: "/reconciliation" },
    ],
  },
  {
    role: "Admin",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Users & Roles", href: "/users" },
      { label: "Settings", href: "/settings" },
    ],
  },
  {
    role: "Patient",
    links: [
      { label: "Queue Status", href: "/queue-status" },
      { label: "Reports", href: "/reports" },
    ],
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold">Hospital MIS</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Phase 0 scaffold — temporary route index. Replaced by role-based redirect
        in Phase 1.
      </p>
      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.role}>
            <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              {group.role}
            </h2>
            <ul className="mt-3 space-y-1.5">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-teal-700 underline-offset-4 hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
