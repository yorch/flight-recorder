import { runPostprocess } from './render.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node src/postprocess/cli.ts <run-dir>');
  process.exit(2);
}
runPostprocess(dir).then(
  () => console.log(`post-processed ${dir}`),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
