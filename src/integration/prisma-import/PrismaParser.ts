import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * Wrapper around @mrleebo/prisma-ast's getSchema().
 * Uses dynamic import so the library is optional.
 */
export class PrismaParser {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async parse(source: string): Promise<any> {
    let prismaAst: { getSchema: (source: string) => unknown };
    try {
      prismaAst = await import("@mrleebo/prisma-ast");
    } catch {
      throw new OrmError(
        OrmErrorCode.MISSING_DEPENDENCY,
        'Package "@mrleebo/prisma-ast" is required for Prisma import. Install it with: pnpm add -D @mrleebo/prisma-ast',
      );
    }

    try {
      return prismaAst.getSchema(source);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new OrmError(
        OrmErrorCode.PRISMA_PARSE_ERROR,
        `Failed to parse Prisma schema: ${message}`,
      );
    }
  }
}
