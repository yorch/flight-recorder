// GitHub Pages project site: https://yorch.github.io/flight-recorder/
// `site` + `base` must stay in step with the Pages deployment (SPEC §14.1).
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://yorch.github.io',
  base: '/flight-recorder',
  integrations: [
    starlight({
      title: 'Flight Recorder',
      description: 'AI-agent-driven browser testing: an agent drives a real sandboxed Chrome, the harness records everything and decides pass or fail.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/yorch/flight-recorder' }],
      editLink: { baseUrl: 'https://github.com/yorch/flight-recorder/edit/main/' },
      customCss: ['./src/styles/custom.css'],
      pagefind: true,
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://yorch.github.io/flight-recorder/poster.png' } },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      lastUpdated: false,
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'Get started', slug: 'readme' },
            { label: 'Architecture notes', slug: 'architecture' },
          ],
        },
        {
          label: 'Reference',
          items: [{ label: 'Technical specification', slug: 'spec' }],
        },
      ],
    }),
  ],
});
