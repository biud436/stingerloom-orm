import {
  ColumnScanner,
  ManyToManyScanner,
  ManyToOneScanner,
  OneToManyScanner,
  OneToOneScanner,
  getScannerInstance,
} from "../../../src/scanner";

/**
 * Clears the column and relation metadata the decorators registered, and
 * keeps the registered entities.
 *
 * For a test that declares its entity classes inside the test body: without
 * it, a class declared by an earlier test leaves its columns and relations in
 * the scanners, and the next registration reads them as its own.
 */
export function clearMappingScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
}
