type CheerioCollection = {
  first(): CheerioCollection;
  text(): string;
  attr(name: string): string | undefined;
  each(callback: (index: number, element: unknown) => void): void;
  map<T>(callback: (index: number, element: unknown) => T): { get(): T[] };
  toArray(): unknown[];
  find(selector: string): CheerioCollection;
  remove(): void;
};

type CheerioApi = ((selector: string) => CheerioCollection) &
  ((element: unknown) => CheerioCollection);

type CheerioModule = {
  load(html: string): CheerioApi;
};

export async function loadCheerioModule(): Promise<CheerioModule> {
  const packageName = "cheerio";

  try {
    const loadedModule = (await import(packageName)) as Partial<CheerioModule>;

    if (typeof loadedModule.load !== "function") {
      throw new Error("Invalid Cheerio module shape");
    }

    return loadedModule as CheerioModule;
  } catch {
    throw new Error(
      [
        "Dependency 'cheerio' belum tersedia di environment ini.",
        "Jalankan: bun add cheerio",
      ].join(" "),
    );
  }
}
