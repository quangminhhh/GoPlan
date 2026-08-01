interface SourceDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

// Keep Node types out of the React Native tsconfig. Jest supplies these runtime
// modules, while the narrow structural types below document the only test-side
// operations this production-source scan is allowed to perform.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readdirSync, readFileSync } = require('fs') as {
  readdirSync(path: string, options: { withFileTypes: true }): SourceDirectoryEntry[];
  readFileSync(path: string, encoding: 'utf8'): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join, relative } = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};

interface ForbiddenProductionSurface {
  readonly label: string;
  readonly pattern: RegExp;
}

const FORBIDDEN_PRODUCTION_SURFACES: readonly ForbiddenProductionSurface[] = [
  { label: 'expo-sharing dependency or import', pattern: /\bexpo-sharing\b/ },
  { label: 'legacy bulk download path builder', pattern: /\btripPhotoBulkDownloadPath\b/ },
  { label: 'legacy bulk request body builder', pattern: /\bbuildBulkDownloadBody\b/ },
  { label: 'legacy ZIP/share orchestrator', pattern: /\bdownloadAndShareTripPhotoArchive\b/ },
  { label: 'legacy bulk request counter', pattern: /\brequestsUsed\b/ },
  { label: 'share-sheet availability check', pattern: /\bisSharingAvailable\b/ },
  { label: 'legacy downloads module import', pattern: /from\s+['"][^'"]*\/downloads['"]/ },
  { label: 'ZIP response handling', pattern: /application\/zip/i },
  { label: 'Download ZIP UI copy', pattern: /\bDownload ZIP\b/i },
  { label: 'Cancel download UI copy', pattern: /\bCancel download\b/i },
  { label: 'share-sheet UI copy', pattern: /\bshare[- ]sheet\b/i },
  { label: 'deprecated native Photos save helper', pattern: /saveToLibraryAsync/ },
  {
    label: 'bearer token in query string',
    pattern: /[?&](?:access_?token|token)=/i,
  },
  {
    label: 'credential logging',
    pattern: /console\.(?:log|warn|error)\([^)]*(?:accessToken|refreshToken|Authorization)/i,
  },
];

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        files.push(...productionSourceFiles(path));
      }
      continue;
    }

    if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

describe('mobile photo production boundary', () => {
  it('contains no removed bulk ZIP or share-sheet surface', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const sourceFiles = productionSourceFiles(sourceRoot);
    const violations = sourceFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return FORBIDDEN_PRODUCTION_SURFACES.filter(({ pattern }) => pattern.test(source)).map(
        ({ label }) => `${relative(sourceRoot, file)}: ${label}`,
      );
    });

    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('pins selected saves to one GET primitive and an opaque native namespace', () => {
    const photoSave = readFileSync(join(process.cwd(), 'src/features/photos/photoSave.ts'), 'utf8');
    const selectedSession = readFileSync(
      join(process.cwd(), 'src/features/photos/selectedPhotoSaveSession.ts'),
      'utf8',
    );
    const tempStore = readFileSync(
      join(process.cwd(), 'src/shared/media/photoSaveTempStore.ts'),
      'utf8',
    );
    const transport = readFileSync(
      join(process.cwd(), 'src/shared/media/protectedTransport.ts'),
      'utf8',
    );
    const nativeActions = readFileSync(
      join(process.cwd(), 'src/features/photos/nativePhotoActions.ts'),
      'utf8',
    );

    expect(selectedSession).toMatch(/saveOneTripPhoto/);
    expect(selectedSession).not.toMatch(/fetchProtectedResponse|method:\s*['"]POST['"]/);
    expect(photoSave).toMatch(/tripPhotoAssetPath\([^)]*['"]download['"]\)/s);
    expect(photoSave).not.toMatch(/method:\s*['"]POST['"]/);
    expect(transport).toMatch(
      /PHOTO_SAVE_TEMP_NAMESPACE\s*=\s*['"]goplan-photo-save['"]/,
    );
    expect(tempStore).toMatch(/createSink\(createOpaqueFileName\(extension\)\)/);
    expect(nativeActions).toMatch(/MediaLibrary\.Asset\.create\(fileUri\)/);
  });
});
