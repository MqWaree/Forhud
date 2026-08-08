import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const sourceDirectory = resolve(import.meta.dirname, "../src/generated/client");
const destinationDirectory = resolve(
  import.meta.dirname,
  "../dist/generated/client",
);

const engineFiles = readdirSync(sourceDirectory).filter(
  (fileName) => fileName.endsWith(".node") && fileName.includes("query_engine"),
);

if (engineFiles.length === 0) {
  throw new Error(
    `No Prisma query engine was generated in ${sourceDirectory}. Run the database client generation step before building.`,
  );
}

mkdirSync(destinationDirectory, { recursive: true });

for (const engineFile of engineFiles) {
  copyFileSync(
    resolve(sourceDirectory, engineFile),
    resolve(destinationDirectory, engineFile),
  );
}
