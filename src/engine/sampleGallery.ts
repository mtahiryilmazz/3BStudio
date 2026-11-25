export interface CharacterSamplePreset {
  id: string;
  title: string;
  subtitle: string;
  assetPath: string;
  kind: 'single' | 'sheet';
  /** Tek yan profil içeriyorsa sağ/sol simetri önerilir. */
  singleSideSymmetry: boolean;
  /** Önceden bilinen odak tipi (bilgi amaçlı). */
  layoutHint: string;
}

export const CHARACTER_SAMPLE_PRESETS: CharacterSamplePreset[] = [
  {
    id: 'studio-single-man',
    title: 'Deri Ceket · Tekli Stüdyo',
    subtitle: 'Tek fotoğraf · Ön (0°)',
    assetPath: '/assets/aistudio/0000_1376e7ae.png',
    kind: 'single',
    singleSideSymmetry: false,
    layoutHint: 'Tek Tam Boy',
  },
  {
    id: 'studio-turnaround-man',
    title: 'Deri Ceket · 3 Açı + 2 Portre',
    subtitle: 'Ön / Tek Yan / Arka + Ana Yüz',
    assetPath: '/assets/aistudio/13e8bee63c5eae5a8bee0d5f61d3a21906d1789b_80735708.png',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: '3 Açı · Simetrik Yan',
  },
  {
    id: 'kaia-vire-sheet',
    title: 'KAIA VIRE · Komple Sheet',
    subtitle: 'Metin/Palet elenir · 4 Açı Turnaround',
    assetPath: '/assets/aistudio/how-does-one-make-an-ai-character-sheet-v0-qlhy6in3ytyg1_afaa3676.webp',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: 'Magazin Sheet',
  },
  {
    id: 'trench-apose-sheet',
    title: 'Trençkot · 4 Açı A-Poz',
    subtitle: 'Ön / Sağ / Sol / Arka + 3 Portre',
    assetPath: '/assets/aistudio/character-reference-sheet-result_9999ced9.jpg',
    kind: 'sheet',
    singleSideSymmetry: false,
    layoutHint: '4 Açı A-Poz',
  },
  {
    id: 'grey-sweater-complete',
    title: 'Gri Kazak · Detaylı Sheet',
    subtitle: 'Ön / Tek Yan / Arka · Kumaş/Poz elenir',
    assetPath: '/assets/aistudio/complete-sheet_3d2e3107.webp',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: '3 Açı + Detay',
  },
  {
    id: 'tpose-jacket-15heads',
    title: 'T-Poz Deri Ceket · 15 Yüz',
    subtitle: 'T-Poz kol kilidi · 15 yüz elenir',
    assetPath: '/assets/aistudio/downadload_52d7c9fb.png',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: 'T-Poz · Simetrik Yan',
  },
  {
    id: 'tpose-camel-15heads',
    title: 'T-Poz Kaban · 15 Yüz',
    subtitle: 'T-Poz kol kilidi · 15 yüz elenir',
    assetPath: '/assets/aistudio/down343oad_4023bbdf.png',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: 'T-Poz · Simetrik Yan',
  },
  {
    id: 'tpose-framed-coat',
    title: 'Çerçeveli T-Poz Kaban',
    subtitle: 'Çerçeve soyma · Ön / Yan / Arka + Yüz',
    assetPath: '/assets/aistudio/user-assets_f371a075-a99b-4073-9344-66186143ed68_78d48cf3d9db4d25b73c5902fec23b48_1-4-edb82cdb-09de-4262-a7b5-e6c3bf562797_d21c487c.png',
    kind: 'sheet',
    singleSideSymmetry: true,
    layoutHint: 'Çerçeveli T-Poz',
  },
];

export interface MechanicalDemoPreset {
  id: 'bracket' | 'knob' | 'figurine';
  title: string;
  subtitle: string;
  recommendedMethod: 'contour-extrude' | 'lathe-revolve' | 'visual-hull';
  cutInteriorHoles: boolean;
}

export const MECHANICAL_DEMO_PRESETS: MechanicalDemoPreset[] = [
  {
    id: 'bracket',
    title: 'L-Braket (Cıvata Delikli)',
    subtitle: 'Kontur Ekstrüzyon · Açık montaj delikleri',
    recommendedMethod: 'contour-extrude',
    cutInteriorHoles: true,
  },
  {
    id: 'knob',
    title: 'Döner Düğme (Simetrik)',
    subtitle: 'Torna (Lathe 360°) · Pürüzsüz silindirik',
    recommendedMethod: 'lathe-revolve',
    cutInteriorHoles: false,
  },
  {
    id: 'figurine',
    title: 'Geometrik Figür',
    subtitle: '5 Açılı Ortoğrafik Görsel Gövde',
    recommendedMethod: 'visual-hull',
    cutInteriorHoles: false,
  },
];
