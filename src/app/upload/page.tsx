import { UploadForm } from '@/components/UploadForm';
import { Button, Empty } from '@/components/ui';
import { listProjects } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  const projects = await listProjects();

  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-[22px] font-semibold tracking-tight">Upload</h1>
        <Empty action={<Button href="/" variant="primary">Create a project</Button>}>
          A transcript has to belong to a project. Create one first.
        </Empty>
      </div>
    );
  }

  const initial = projects.find((p) => p.slug === project)?.slug;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Upload a transcript</h1>
        <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
          Preview first: a file that touches days already held is resolved day by day, so a
          cumulative re-export never doubles the figures.
        </p>
      </div>
      <UploadForm
        projects={projects.map((p) => ({ name: p.name, slug: p.slug, colour: p.colour }))}
        initialProjectSlug={initial}
      />
    </div>
  );
}
