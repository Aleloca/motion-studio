import type { EventsState } from '../eventsReducer.ts';
export function CreativePage({ slug, creative }: { slug: string; creative: string; live: EventsState; expert: boolean }) { return <main className="page">{slug}/{creative}</main>; }
