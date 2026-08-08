export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
        Billing
      </p>
      <h1 className="text-2xl font-semibold">Invoice</h1>
      <p className="text-sm text-zinc-500">Placeholder screen · Invoice ID: {id}</p>
    </main>
  );
}
