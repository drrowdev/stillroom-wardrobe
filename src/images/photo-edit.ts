export type Crop = { x: number; y: number; width: number; height: number };
export type PhotoEdit = { turns: number; crop: Crop };
export const FULL_CROP: Crop = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
export const ORIGINAL_EDIT: PhotoEdit = Object.freeze({ turns: 0, crop: FULL_CROP });
