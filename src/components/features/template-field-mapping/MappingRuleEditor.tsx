/**
 * @fileoverview 映射規則編輯器組件
 * @description
 *   管理多條映射規則的編輯器
 *   支援新增、刪除、重新排序（↑↓ 按鈕 + @dnd-kit 拖放，CHANGE-075）
 *
 * @module src/components/features/template-field-mapping
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-06-03
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Plus, AlertCircle } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

import { MappingRuleItem } from './MappingRuleItem';
import type { TemplateField } from './TargetFieldSelector';
import type {
  TemplateFieldMappingRule,
  TemplateFieldMappingRuleInput,
} from '@/types/template-field-mapping';

// ============================================================================
// Types
// ============================================================================

interface MappingRuleEditorProps {
  rules: Partial<TemplateFieldMappingRuleInput>[];
  onChange: (rules: Partial<TemplateFieldMappingRuleInput>[]) => void;
  templateFields: TemplateField[];
  /** 文件格式 ID（用於載入動態提取欄位，僅 FORMAT scope 時傳入） */
  formatId?: string;
  /** FieldDefinitionSet 解析上下文（用於載入自訂欄位定義） @since CHANGE-045 */
  resolveByContext?: { companyId?: string; formatId?: string };
  disabled?: boolean;
  error?: string;
  className?: string;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * @component MappingRuleEditor
 * @description 映射規則編輯器
 */
export function MappingRuleEditor({
  rules,
  onChange,
  templateFields,
  formatId,
  resolveByContext,
  disabled = false,
  error,
  className,
}: MappingRuleEditorProps) {
  const t = useTranslations('templateFieldMapping');

  // Stable client-side ids for each rule — used by drag-and-drop (dnd-kit
  // requires a stable id per sortable item) and for tracking which rule is
  // expanded across reorders. These are transient and NOT persisted: the
  // parent form rebuilds the submit payload field-by-field, so they never
  // reach the API. The ids array is kept length-aligned with `rules` by
  // updating it inside every handler that changes the rule count/order.
  const idCounterRef = React.useRef(0);
  const makeId = React.useCallback(() => `rule-${idCounterRef.current++}`, []);
  const [ids, setIds] = React.useState<string[]>(() => rules.map(() => makeId()));

  // Track expanded rule by its stable id (index-based tracking would break
  // when rules are reordered).
  const [expandedId, setExpandedId] = React.useState<string | null>(
    () => ids[0] ?? null
  );

  // Drag sensors: pointer (with small activation distance to avoid hijacking
  // clicks) + keyboard (accessible reordering).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Get used fields
  const usedSourceFields = React.useMemo(
    () => rules.map((r) => r.sourceField).filter(Boolean) as string[],
    [rules]
  );

  const usedTargetFields = React.useMemo(
    () => rules.map((r) => r.targetField).filter(Boolean) as string[],
    [rules]
  );

  // Add new rule
  const handleAddRule = React.useCallback(() => {
    const newRule: Partial<TemplateFieldMappingRuleInput> = {
      sourceField: '',
      targetField: '',
      transformType: 'DIRECT',
      transformParams: null,
      isRequired: false,
      order: rules.length,
      description: '',
    };
    const newId = makeId();
    onChange([...rules, newRule]);
    setIds((prev) => [...prev, newId]);
    setExpandedId(newId);
  }, [rules, onChange, makeId]);

  // Update rule
  const handleRuleChange = React.useCallback(
    (index: number, updatedRule: Partial<TemplateFieldMappingRuleInput>) => {
      const newRules = rules.map((rule, i) =>
        i === index ? updatedRule : rule
      );
      onChange(newRules);
    },
    [rules, onChange]
  );

  // Delete rule
  const handleDeleteRule = React.useCallback(
    (index: number) => {
      const removedId = ids[index];
      const newRules = rules
        .filter((_, i) => i !== index)
        .map((rule, i) => ({ ...rule, order: i }));
      onChange(newRules);
      setIds((prev) => prev.filter((_, i) => i !== index));
      if (expandedId === removedId) {
        setExpandedId(null);
      }
    },
    [rules, onChange, ids, expandedId]
  );

  // Move a rule to a new position, reindexing every rule's `order` to match
  // its new array position. This reindexing is required for correctness:
  // the projection merge path sorts target fields by `order`, so a stale
  // `order` would produce the wrong output column order.
  const handleMove = React.useCallback(
    (from: number, to: number) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= rules.length ||
        to >= rules.length
      ) {
        return;
      }
      const reordered = arrayMove(rules, from, to).map((rule, i) => ({
        ...rule,
        order: i,
      }));
      onChange(reordered);
      setIds((prev) => arrayMove(prev, from, to));
    },
    [rules, onChange]
  );

  const handleMoveUp = React.useCallback(
    (index: number) => handleMove(index, index - 1),
    [handleMove]
  );

  const handleMoveDown = React.useCallback(
    (index: number) => handleMove(index, index + 1),
    [handleMove]
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      handleMove(from, to);
    },
    [ids, handleMove]
  );

  // Toggle expand (tracked by stable id)
  const handleExpandToggle = React.useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className={cn('space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-base font-medium">
            {t('mappingRules.title')}
          </Label>
          <p className="text-sm text-muted-foreground">
            {t('mappingRules.description', { count: rules.length })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleAddRule}
          disabled={disabled}
        >
          <Plus className="h-4 w-4 mr-2" />
          {t('mappingRules.addRule')}
        </Button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Rules List */}
      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-muted-foreground">{t('mappingRules.empty')}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={handleAddRule}
            disabled={disabled}
          >
            <Plus className="h-4 w-4 mr-2" />
            {t('mappingRules.addFirstRule')}
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {rules.map((rule, index) => (
                <MappingRuleItem
                  key={ids[index]}
                  sortableId={ids[index]}
                  rule={rule}
                  index={index}
                  total={rules.length}
                  onChange={(updated) => handleRuleChange(index, updated)}
                  onDelete={() => handleDeleteRule(index)}
                  onMoveUp={() => handleMoveUp(index)}
                  onMoveDown={() => handleMoveDown(index)}
                  templateFields={templateFields}
                  usedSourceFields={usedSourceFields}
                  usedTargetFields={usedTargetFields}
                  formatId={formatId}
                  resolveByContext={resolveByContext}
                  isExpanded={expandedId === ids[index]}
                  onExpandToggle={() => handleExpandToggle(ids[index])}
                  disabled={disabled}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Summary */}
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span>
            {t('mappingRules.totalRules', { count: rules.length })}
          </span>
          <span>
            {t('mappingRules.requiredRules', {
              count: rules.filter((r) => r.isRequired).length,
            })}
          </span>
          <span>
            {t('mappingRules.unmappedTemplateFields', {
              count: templateFields.length - usedTargetFields.length,
            })}
          </span>
        </div>
      )}
    </div>
  );
}
