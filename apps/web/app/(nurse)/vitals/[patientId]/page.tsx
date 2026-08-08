export default async function VitalsPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
        Nurse
      </p>
      <h1 className="text-2xl font-semibold">Vitals Entry</h1>
      <p className="text-sm text-zinc-500">
        Placeholder screen · Patient ID: {patientId}
      </p>
    </main>
  );
}
