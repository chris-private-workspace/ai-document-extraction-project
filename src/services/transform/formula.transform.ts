/**
 * @fileoverview FORMULA 公式計算轉換器
 * @description
 *   實現公式計算的轉換邏輯，支援變數佔位符和基本數學運算
 *   安全執行：只允許數字和基本運算符
 *
 * @module src/services/transform/formula
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-01-22
 *
 * @features
 *   - 變數佔位符替換 {field_name}
 *   - 基本運算符支援 + - * / ( )
 *   - 安全的公式求值
 *   - 數值類型檢查
 *
 * @dependencies
 *   - ./types.ts - Transform 介面
 */

import type {
  Transform,
  TransformContext,
  TransformParams,
  FormulaTransformParams,
} from './types';

// ============================================================================
// Constants
// ============================================================================

/**
 * 允許的公式字符（數字、運算符、空白、小數點、括號）
 */
const SAFE_FORMULA_PATTERN = /^[\d\s\+\-\*\/\.\(\)]+$/;

/**
 * 變數佔位符模式 {field_name}
 */
const VARIABLE_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

// ============================================================================
// 受限算術求值器（FIX-072：取代 Function 動態求值，從架構上消除 RCE 攻擊面）
// ============================================================================
//
// 設計：tokenize（白名單 token）→ shunting-yard 轉後綴（RPN）→ 逐 token 計算。
// 全程不使用 Function/eval，無論輸入如何都不可能執行任意 JS。
// 僅支援數字、+ - * / 與括號（含一元正負號），與既有 SAFE_FORMULA_PATTERN 涵蓋範圍一致，
// 確保既有合法公式（變數替換後的純算術式）計算結果不變。

/** 算術 token（tokenize 階段產出） */
type ArithmeticToken =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' }
  | { type: 'paren'; value: '(' | ')' };

/** RPN token（含一元運算符 u- / u+） */
type RpnOperator = '+' | '-' | '*' | '/' | 'u-' | 'u+';
type RpnToken =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: RpnOperator };

/** 運算符優先級（數字越大越優先）；一元運算符最高 */
const OPERATOR_PRECEDENCE: Record<RpnOperator, number> = {
  'u-': 3,
  'u+': 3,
  '*': 2,
  '/': 2,
  '+': 1,
  '-': 1,
};

/** 右結合運算符（一元正負號） */
const RIGHT_ASSOCIATIVE: ReadonlySet<RpnOperator> = new Set(['u-', 'u+']);

/**
 * 將算術表達式切分為 token。
 * 只接受數字、小數點、+ - * / 與括號；遇到任何其他字符即拋錯（白名單）。
 */
function tokenizeArithmetic(expression: string): ArithmeticToken[] {
  const tokens: ArithmeticToken[] = [];
  let i = 0;

  while (i < expression.length) {
    const char = expression[i];

    // 跳過空白
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i++;
      continue;
    }

    // 數字（含小數點）
    if ((char >= '0' && char <= '9') || char === '.') {
      let numStr = '';
      while (
        i < expression.length &&
        ((expression[i] >= '0' && expression[i] <= '9') || expression[i] === '.')
      ) {
        numStr += expression[i];
        i++;
      }
      const value = Number(numStr);
      if (!Number.isFinite(value)) {
        throw new Error(`無效的數字: ${numStr}`);
      }
      tokens.push({ type: 'number', value });
      continue;
    }

    // 運算符
    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    // 括號
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      i++;
      continue;
    }

    // 其他字符一律拒絕
    throw new Error(`公式包含不允許的字符: ${char}`);
  }

  return tokens;
}

/**
 * Shunting-yard 演算法：將中綴 token 轉為後綴（RPN）。
 * 同時依前一 token 判定 + / - 為一元（u+ / u-）或二元。
 */
function toReversePolish(tokens: ArithmeticToken[]): RpnToken[] {
  const output: RpnToken[] = [];
  const operators: Array<RpnOperator | '('> = [];
  // 追蹤前一個有意義 token，用於判斷一元運算符
  let prevType: 'number' | 'operator' | 'open-paren' | 'close-paren' | null = null;

  for (const token of tokens) {
    if (token.type === 'number') {
      output.push({ type: 'number', value: token.value });
      prevType = 'number';
      continue;
    }

    if (token.type === 'operator') {
      // 一元判定：位於開頭、運算符之後或左括號之後
      const isUnary =
        prevType === null || prevType === 'operator' || prevType === 'open-paren';
      let op: RpnOperator;
      if (isUnary) {
        if (token.value === '-') op = 'u-';
        else if (token.value === '+') op = 'u+';
        else throw new Error(`運算符 ${token.value} 缺少左運算元`);
      } else {
        op = token.value;
      }

      // 彈出優先級更高（或同級且左結合）的堆疊頂運算符
      while (operators.length > 0) {
        const top = operators[operators.length - 1];
        if (top === '(') break;
        const shouldPop =
          OPERATOR_PRECEDENCE[top] > OPERATOR_PRECEDENCE[op] ||
          (OPERATOR_PRECEDENCE[top] === OPERATOR_PRECEDENCE[op] &&
            !RIGHT_ASSOCIATIVE.has(op));
        if (!shouldPop) break;
        output.push({ type: 'operator', value: operators.pop() as RpnOperator });
      }
      operators.push(op);
      prevType = 'operator';
      continue;
    }

    // 括號
    if (token.value === '(') {
      operators.push('(');
      prevType = 'open-paren';
    } else {
      let foundOpen = false;
      while (operators.length > 0) {
        const top = operators.pop() as RpnOperator | '(';
        if (top === '(') {
          foundOpen = true;
          break;
        }
        output.push({ type: 'operator', value: top });
      }
      if (!foundOpen) {
        throw new Error('括號不平衡：多餘的右括號');
      }
      prevType = 'close-paren';
    }
  }

  while (operators.length > 0) {
    const top = operators.pop() as RpnOperator | '(';
    if (top === '(') {
      throw new Error('括號不平衡：缺少右括號');
    }
    output.push({ type: 'operator', value: top });
  }

  return output;
}

/**
 * 計算 RPN token 序列（純數值堆疊運算，無 eval）。
 */
function evaluateReversePolish(rpn: RpnToken[]): number {
  const stack: number[] = [];

  for (const token of rpn) {
    if (token.type === 'number') {
      stack.push(token.value);
      continue;
    }

    // 一元運算符
    if (token.value === 'u-' || token.value === 'u+') {
      const operand = stack.pop();
      if (operand === undefined) {
        throw new Error('表達式無效：一元運算符缺少運算元');
      }
      stack.push(token.value === 'u-' ? -operand : operand);
      continue;
    }

    // 二元運算符
    const right = stack.pop();
    const left = stack.pop();
    if (left === undefined || right === undefined) {
      throw new Error('表達式無效：運算符缺少運算元');
    }

    switch (token.value) {
      case '+':
        stack.push(left + right);
        break;
      case '-':
        stack.push(left - right);
        break;
      case '*':
        stack.push(left * right);
        break;
      case '/':
        // 保留 JS 語義（除以零 → Infinity / 0/0 → NaN），由外層 Number.isFinite 守門
        stack.push(left / right);
        break;
    }
  }

  if (stack.length !== 1) {
    throw new Error('表達式無效：運算元與運算符數量不匹配');
  }

  return stack[0];
}

/**
 * 受限算術求值入口：tokenize → RPN → 計算。
 *
 * @param expression 已移除空白、已通過白名單字符檢查的純算術表達式
 * @returns 計算結果
 * @throws Error 表達式語法無效時拋出
 */
function evaluateArithmetic(expression: string): number {
  const tokens = tokenizeArithmetic(expression);
  if (tokens.length === 0) {
    throw new Error('公式不能為空');
  }
  const rpn = toReversePolish(tokens);
  return evaluateReversePolish(rpn);
}

// ============================================================================
// Formula Transform Implementation
// ============================================================================

/**
 * FORMULA 公式計算轉換器
 * @description
 *   支援變數佔位符和基本數學運算
 *   會替換公式中的 {field_name} 為實際值後計算
 *
 * @example
 * ```typescript
 * const transform = new FormulaTransform();
 * const context = {
 *   row: { sea_freight: 500, terminal_handling: 100 },
 *   sourceField: 'sea_freight',
 *   targetField: 'total_shipping'
 * };
 * const params = { formula: '{sea_freight} + {terminal_handling}' };
 * const result = await transform.execute(500, params, context);
 * // result: 600
 * ```
 */
export class FormulaTransform implements Transform {
  /**
   * 轉換類型
   */
  readonly type = 'FORMULA' as const;

  /**
   * 執行公式計算
   *
   * @description
   *   1. 解析公式中的變數佔位符
   *   2. 替換為實際數值
   *   3. 安全計算公式結果
   *
   * @param _value - 源欄位值（公式模式下通常不直接使用）
   * @param params - 公式參數
   * @param context - 轉換上下文（提供整行資料用於變數替換）
   * @returns 計算結果
   * @throws Error 公式無效或計算失敗時拋出
   */
  async execute(
    _value: unknown,
    params: TransformParams,
    context: TransformContext
  ): Promise<unknown> {
    const formulaParams = params as FormulaTransformParams;

    if (!formulaParams?.formula) {
      throw new Error('FORMULA 轉換需要提供 formula 參數');
    }

    // FIX-157：公式引用的變數若全部缺值，回傳 undefined 而非 0。
    // 呼叫端（template-matching-engine 的 transformFields）只在結果不是 undefined 時
    // 才寫入該欄位，因此這裡與 DIRECT 行為一致 ——「這張發票沒有這筆費用」留空，
    // 不會顯示成「這筆費用是 0」。
    if (!this.hasAnyReferencedValue(formulaParams.formula, context.row)) {
      return undefined;
    }

    // 替換變數佔位符
    const expression = this.replaceVariables(formulaParams.formula, context.row);

    // 安全計算
    return this.safeEval(expression);
  }

  /**
   * 判斷公式引用的變數中是否至少有一個具備可用數值
   *
   * @description
   *   FIX-157：全部缺值時 `replaceVariables` 會把每個佔位符換成 '0'，公式因而算出 0，
   *   使「沒有這筆費用」與「金額為零」無法分辨。此方法讓 execute 能在該情況下回傳
   *   undefined。只要任一變數有值，仍維持原行為（其餘缺值視為 0 參與計算）。
   *
   *   公式若完全不含變數（純常數式），視為有值以保留原行為。
   *
   * @param formula - 原始公式
   * @param row - 整行資料
   * @returns 至少一個引用變數有可用數值時為 true
   */
  private hasAnyReferencedValue(formula: string, row: Record<string, unknown>): boolean {
    let referenced = 0;

    for (const match of formula.matchAll(VARIABLE_PATTERN)) {
      referenced++;
      const value = row[match[1]];
      if (value === undefined || value === null) continue;
      // 空字串代表「沒有這筆費用」，不可當作有值 —— Number('') 為 0，會漏掉這一類
      if (typeof value === 'string' && value.trim() === '') continue;
      if (Number.isNaN(Number(value))) continue;
      return true;
    }

    return referenced === 0;
  }

  /**
   * 替換公式中的變數佔位符
   *
   * @param formula - 原始公式
   * @param row - 整行資料
   * @returns 替換後的表達式
   */
  private replaceVariables(formula: string, row: Record<string, unknown>): string {
    return formula.replace(VARIABLE_PATTERN, (match, fieldName) => {
      const value = row[fieldName];

      if (value === undefined || value === null) {
        // 缺失值視為 0
        return '0';
      }

      const numValue = Number(value);
      if (Number.isNaN(numValue)) {
        // 非數值視為 0
        return '0';
      }

      return String(numValue);
    });
  }

  /**
   * 安全計算公式
   *
   * @description
   *   只允許數字和基本運算符，防止代碼注入。
   *   FIX-072：以受限算術解析器（tokenize → RPN → 計算）求值，
   *   完全不使用 Function/eval，從架構上消除 RCE 攻擊面。
   *
   * @param expression - 純數字表達式
   * @returns 計算結果
   * @throws Error 公式無效時拋出
   */
  private safeEval(expression: string): number {
    // 移除空白後檢查
    const cleanExpr = expression.replace(/\s+/g, '');

    // 第一道防線：白名單字符快速檢查（縱深防禦；求值核心已不依賴此正則）
    if (!SAFE_FORMULA_PATTERN.test(cleanExpr)) {
      throw new Error(`公式包含不允許的字符: ${expression}`);
    }

    // 檢查是否為空表達式
    if (!cleanExpr || cleanExpr === '') {
      throw new Error('公式不能為空');
    }

    try {
      // FIX-072：受限算術解析器求值（取代 Function，無任何 eval 路徑）
      const result = evaluateArithmetic(cleanExpr);

      // 檢查結果是否有效
      if (typeof result !== 'number' || Number.isNaN(result) || !Number.isFinite(result)) {
        throw new Error(`公式計算結果無效: ${expression} = ${result}`);
      }

      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`公式計算失敗: ${expression} - ${error.message}`);
      }
      throw new Error(`公式計算失敗: ${expression}`);
    }
  }

  /**
   * 驗證轉換參數
   *
   * @param params - 轉換參數
   * @returns 驗證結果
   */
  validateParams(params: TransformParams): { isValid: boolean; error?: string } {
    const formulaParams = params as FormulaTransformParams;

    if (!formulaParams) {
      return { isValid: false, error: 'FORMULA 轉換需要提供參數' };
    }

    if (!formulaParams.formula || typeof formulaParams.formula !== 'string') {
      return { isValid: false, error: 'FORMULA 轉換需要提供 formula 字串' };
    }

    if (formulaParams.formula.trim() === '') {
      return { isValid: false, error: 'formula 不能為空' };
    }

    // 驗證公式語法（替換變數為 0 後檢查）
    const testExpr = formulaParams.formula.replace(VARIABLE_PATTERN, '0');
    const cleanExpr = testExpr.replace(/\s+/g, '');

    if (!SAFE_FORMULA_PATTERN.test(cleanExpr)) {
      return {
        isValid: false,
        error: `公式包含不允許的字符，只允許數字和運算符 + - * / ( )`,
      };
    }

    return { isValid: true };
  }
}

// ============================================================================
// Export
// ============================================================================

/**
 * FORMULA 轉換器單例
 */
export const formulaTransform = new FormulaTransform();
