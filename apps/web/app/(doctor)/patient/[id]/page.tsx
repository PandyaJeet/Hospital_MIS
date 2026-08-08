export default async function PatientChartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
        Doctor
      </p>
      <h1 className="text-2xl font-semibold">Patient Chart</h1>
      <p className="text-sm text-zinc-500">Placeholder screen · Patient ID: {id}</p>
    </main>
  );
}
