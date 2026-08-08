import{copyFileSync}from'node:fs';copyFileSync(new URL('../manifest.json',import.meta.url),new URL('../dist/manifest.json',import.meta.url));
