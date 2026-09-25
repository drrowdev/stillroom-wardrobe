import { buildAll } from './builds';

export default async function globalSetup() {
  await buildAll();
}

