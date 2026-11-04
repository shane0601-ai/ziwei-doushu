import { SCHOOL_AX } from './school-tables.generated';

/** 按生年地支起虚岁一岁，男顺女逆，每岁一宫。返回子起零的地支索引。 */
export function getXiaoXianBranch(birthBranch: number, nominalAge: number, gender: 'male' | 'female'): number {
  const startBranch = SCHOOL_AX.XIAOXIAN[birthBranch + 1] - 1;
  const offset = (nominalAge - 1) * (gender === 'male' ? 1 : -1);
  return ((startBranch + offset) % 12 + 12) % 12;
}
