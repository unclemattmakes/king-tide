import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'King Tide',
  description: 'Developer + modder docs for the King Tide racer.',
  cleanUrls: true,
  lastUpdated: true,

  // Anti-grav is cut (parked for a possible DLC). Its authoring cookbook is
  // kept in-repo but excluded from the built site so modders aren't shown a
  // feature no shipped track uses.
  srcExclude: ['blender/antigrav-surfaces.md'],

  head: [['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]],

  themeConfig: {
    nav: [
      { text: 'Build', link: '/build/setup' },
      { text: 'Gameplay', link: '/gameplay/bikes' },
      { text: 'Modding', link: '/modding/overview' },
      { text: 'Blender', link: '/blender/overview' },
      { text: 'Contributing', link: '/contributing/' },
      { text: 'Reference', link: '/reference/conventions' },
      {
        text: 'Making of',
        link: 'https://kingtide.unclemattmakes.com/making-of/',
      },
      {
        text: 'Live build',
        link: 'https://kingtide.unclemattmakes.com',
      },
    ],

    sidebar: {
      '/build/': [
        {
          text: 'Build & Run',
          items: [
            { text: 'Setup', link: '/build/setup' },
            { text: 'Controls', link: '/build/controls' },
            { text: 'Platform & browser support', link: '/build/platform' },
          ],
        },
      ],
      '/gameplay/': [
        {
          text: 'Gameplay',
          items: [
            { text: 'Bikes & stats', link: '/gameplay/bikes' },
            { text: 'Pickups & combat', link: '/gameplay/pickups' },
            { text: 'Tracks & races', link: '/gameplay/tracks' },
          ],
        },
      ],
      '/modding/': [
        {
          text: 'Modding',
          items: [
            { text: 'Pipeline overview', link: '/modding/overview' },
            { text: 'Authoring bikes', link: '/modding/bikes' },
            { text: 'Authoring props', link: '/modding/props' },
            { text: 'Authoring tracks', link: '/modding/tracks' },
          ],
        },
      ],
      '/blender/': [
        {
          text: 'Blender',
          items: [
            { text: 'Overview', link: '/blender/overview' },
            { text: 'Your first track', link: '/blender/your-first-track' },
            { text: 'Addon reference', link: '/blender/addon-reference' },
            { text: 'Scene conventions', link: '/blender/scene-conventions' },
          ],
        },
        {
          text: 'Cookbooks',
          items: [{ text: 'Wave zones', link: '/blender/wave-zones' }],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Conventions', link: '/reference/conventions' },
            { text: 'Debug API', link: '/reference/debug-api' },
            { text: 'URL parameters', link: '/reference/url-params' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [
            { text: 'Overview', link: '/contributing/' },
            { text: 'Architecture', link: '/contributing/architecture' },
            { text: 'Testing', link: '/contributing/testing' },
            { text: 'Code review', link: '/contributing/code-review' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/unclemattmakes/king-tide' }],

    editLink: {
      pattern: 'https://github.com/unclemattmakes/king-tide/edit/main/docs-site/:path',
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    footer: {
      message: 'Made with VitePress.',
      copyright: 'OddballCreatureClub — King Tide',
    },
  },
})
