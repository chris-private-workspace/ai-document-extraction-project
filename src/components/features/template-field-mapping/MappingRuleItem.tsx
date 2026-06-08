/**
 * @fileoverview 映射規則項目組件
 * @description
 *   顯示單一映射規則，支援展開/收起詳細配置
 *   以及排序操作（↑↓ 按鈕 + @dnd-kit 拖放手柄，CHANGE-075）
 *
 * @module src/components/features/template-field-mapping
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-06-03
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Trash2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import { SourceFieldCombobox } from '../formats/SourceFieldCombobox';
import { TargetFieldSelector, TargetFieldDisplay, type TemplateField } from './TargetFieldSelector';
import { TransformConfigEditor } from './TransformConfigEditor';
import type {
  TemplateFieldMappingRule,
  FieldTransformType,
  TransformParams,
} from '@/types/template-field-mapping';
import { TRANSFORM_TYPE_OPTIONS } from '@/types/template-field-mapping';

// ============================================================================
// Types
// ============================================================================

interface MappingRuleItemProps {
  rule: Partial<TemplateFieldMappingRule>;
  index: number;
  /** 規則總數（用於判斷下移按鈕是否到底） */
  total: number;
  /** 拖放排序用的穩定 client id */
  sortableId: string;
  onChange: (rule: Partial<TemplateFieldMappingRule>) => void;
  onDelete: () => void;
  /** 上移此規則 */
  onMoveUp: () => void;
  /** 下移此規則 */
  onMoveDown: () => void;
  templateFields: TemplateField[];
  usedSourceFields: string[];
  usedTargetFields: string[];
  /** 文件格式 ID（用於載入動態提取欄位） */
  formatId?: string;
  /** FieldDefinitionSet 解析上下文（用於載入自訂欄位定義） @since CHANGE-045 */
  resolveByContext?: { companyId?: string; formatId?: string };
  isExpanded?: boolean;
  onExpandToggle?: () => void;
  disabled?: boolean;
  errors?: Record<string, string>;
  className?: string;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * @component MappingRuleItem
 * @description 單一映射規則項目
 */
export function MappingRuleItem({
  rule,
  index,
  total,
  sortableId,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  templateFields,
  usedSourceFields,
  usedTargetFields,
  formatId,
  resolveByContext,
  isExpanded = false,
  onExpandToggle,
  disabled = false,
  errors,
  className,
}: MappingRuleItemProps) {
  const t = useTranslations('templateFieldMapping');

  // --- Sortable (drag-and-drop) Setup ---
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : undefined,
  };

  // Use ref to track latest rule to avoid stale closure when
  // TransformConfigEditor calls onTransformTypeChange + onTransformParamsChange sequentially
  const ruleRef = React.useRef(rule);
  ruleRef.current = rule;

  // Get transform type label
  const transformTypeLabel = React.useMemo(() => {
    const option = TRANSFORM_TYPE_OPTIONS.find((o) => o.value === rule.transformType);
    return option ? t(`transformType.${option.value.toLowerCase()}`) : '-';
  }, [rule.transformType, t]);

  // Handle field changes
  const handleSourceFieldChange = React.useCallback(
    (value: string | string[]) => {
      const sourceField = Array.isArray(value) ? value[0] || '' : value;
      onChange({ ...ruleRef.current, sourceField });
    },
    [onChange]
  );

  const handleTargetFieldChange = React.useCallback(
    (targetField: string) => {
      // Auto-set isRequired based on template field
      const templateField = templateFields.find((f) => f.name === targetField);
      onChange({
        ...ruleRef.current,
        targetField,
        isRequired: templateField?.isRequired ?? ruleRef.current.isRequired ?? false,
      });
    },
    [onChange, templateFields]
  );

  const handleTransformTypeChange = React.useCallback(
    (transformType: FieldTransformType) => {
      const updated = { ...ruleRef.current, transformType };
      ruleRef.current = updated;
      onChange(updated);
    },
    [onChange]
  );

  const handleTransformParamsChange = React.useCallback(
    (transformParams: TransformParams) => {
      const updated = { ...ruleRef.current, transformParams };
      ruleRef.current = updated;
      onChange(updated);
    },
    [onChange]
  );

  const handleIsRequiredChange = React.useCallback(
    (isRequired: boolean) => {
      onChange({ ...ruleRef.current, isRequired });
    },
    [onChange]
  );

  const handleDescriptionChange = React.useCallback(
    (description: string) => {
      onChange({ ...ruleRef.current, description });
    },
    [onChange]
  );

  // Filter used fields (exclude current rule)
  const filteredUsedSourceFields = usedSourceFields.filter(
    (f) => f !== rule.sourceField
  );
  const filteredUsedTargetFields = usedTargetFields.filter(
    (f) => f !== rule.targetField
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border bg-card transition-shadow',
        isExpanded && 'shadow-sm',
        isDragging && 'shadow-lg',
        errors && Object.keys(errors).length > 0 && 'border-destructive',
        className
      )}
    >
      {/* Header / Summary Row */}
      <div className="flex items-center gap-2 p-3">
        {/* Drag Handle */}
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            'cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            isDragging && 'cursor-grabbing',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          disabled={disabled}
          aria-label={t('rule.dragHandle')}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        {/* Index */}
        <Badge variant="outline" className="w-8 justify-center">
          {index + 1}
        </Badge>

        {/* Source Field */}
        <div className="flex-1 min-w-0">
          {isExpanded ? (
            <SourceFieldCombobox
              value={rule.sourceField || ''}
              onChange={handleSourceFieldChange}
              formatId={formatId}
              resolveByContext={resolveByContext}
              usedFields={filteredUsedSourceFields}
              disabled={disabled}
              className="w-full"
              showLineItemFields
              showReferenceNumberFields
            />
          ) : (
            <div className="text-sm truncate">
              {rule.sourceField || (
                <span className="text-muted-foreground">{t('rule.noSourceField')}</span>
              )}
            </div>
          )}
        </div>

        {/* Arrow */}
        <div className="flex items-center gap-1 text-muted-foreground">
          <ArrowRight className="h-4 w-4" />
          <Badge variant="secondary" className="text-xs">
            {transformTypeLabel}
          </Badge>
          <ArrowRight className="h-4 w-4" />
        </div>

        {/* Target Field */}
        <div className="flex-1 min-w-0">
          {isExpanded ? (
            <TargetFieldSelector
              value={rule.targetField || ''}
              onChange={handleTargetFieldChange}
              templateFields={templateFields}
              usedFields={filteredUsedTargetFields}
              disabled={disabled}
            />
          ) : (
            <div className="text-sm truncate">
              {rule.targetField || (
                <span className="text-muted-foreground">{t('rule.noTargetField')}</span>
              )}
            </div>
          )}
        </div>

        {/* Required Badge */}
        {rule.isRequired && (
          <Badge variant="destructive" className="text-[10px]">
            {t('rule.required')}
          </Badge>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1">
          {/* Move Up / Down */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onMoveUp}
            disabled={disabled || index === 0}
            aria-label={t('rule.moveUp')}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onMoveDown}
            disabled={disabled || index === total - 1}
            aria-label={t('rule.moveDown')}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onExpandToggle}
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onDelete}
            disabled={disabled}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t px-4 py-4 space-y-4">
          {/* Transform Config */}
          <TransformConfigEditor
            transformType={rule.transformType || 'DIRECT'}
            transformParams={rule.transformParams ?? null}
            onTransformTypeChange={handleTransformTypeChange}
            onTransformParamsChange={handleTransformParamsChange}
            companyId={resolveByContext?.companyId}
            disabled={disabled}
            errors={errors}
          />

          {/* Additional Options */}
          <div className="flex flex-wrap gap-6">
            {/* Is Required */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id={`rule-${index}-required`}
                checked={rule.isRequired ?? false}
                onCheckedChange={handleIsRequiredChange}
                disabled={disabled}
              />
              <Label
                htmlFor={`rule-${index}-required`}
                className="text-sm font-normal"
              >
                {t('rule.markRequired')}
              </Label>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('rule.description')}</Label>
            <Input
              value={rule.description || ''}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              placeholder={t('rule.descriptionPlaceholder')}
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}
