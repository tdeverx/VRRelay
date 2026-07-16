import type { Reroute } from '@sveltejs/kit';

export const reroute: Reroute = ({ url }) => {
  if (url.pathname === '/dashboard') return '/new';
  if (url.pathname.startsWith('/dashboard/'))
    return `/new${url.pathname.slice('/dashboard'.length)}`;
  return url.pathname;
};
