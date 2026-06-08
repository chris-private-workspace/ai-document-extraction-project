'use client';

/**
 * @fileoverview 候選欄位選擇器
 * @description
 *   核心組件：按 8 類別分組的候選欄位選擇器。
 *   - 從 GET /candidates API 載入 ~90 候選欄位
 *   - 按 category 分組，可折疊
 *   - 每個 category 支援全選 checkbox
 *   - 已選欄位可展開 FieldEntryEditor 編輯屬性
 *   - 支援新增自定義欄位
 *   - 搜尋過濾功能
 *
 * @module src/components/features/field-definition-set/FieldCandidatePicker
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/hooks/use-field-definition-sets - useFieldCandidates
 *   - ./FieldEntryEditor - 單欄位編輯器
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  Search,
  Plus,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useFieldCandidates } from '@/hooks/use-field-definition-sets';
import { FieldEntryEditor } from './FieldEntryEditor';
import type { FieldDefinitionEntry, FieldDefinitionFieldType } from '@/types/extraction-v3.types';

// ============================================================
// Types
// ============================================================

interface FieldCandidatePickerProps {
  selectedFields: FieldDefinitionEntry[];
  onChange: (fields: FieldDefinitionEntry[]) => void;
}

interface GroupedCandidate {
  category: string;
  items: FieldDefinitionEntry[];
}

// ============================================================
// Constants
// ============================================================

const CATEGORY_ORDER = [
  'basic',
  'shipper',
  'consignee',
  'shipping',
  'package',
  'charges',
  'reference',
  'payment',
];

const DATA_TYPES = ['string', 'number', 'date', 'currency'] as const;

// ============================================================
// Component
// ============================================================

export function FieldCandidatePicker({
  selectedFields,
  onChange,
}: FieldCandidatePickerProps) {
  const t = useTranslations('fieldDefinitionSet');
  const { data: candidates, isLoading } = useFieldCandidates();

  const [search, setSearch] = React.useState('');
  const [collapsedCategories, setCollapsedCategories] = React.useState<
    Set<string>
  >(new Set());
  const [showCustomForm, setShowCustomForm] = React.useState(false);
  const [customKey, setCustomKey] = React.useState('');
  const [customLabel, setCustomLabel] = React.useState('');
  const [customCategory, setCustomCategory] = React.useState('basic');
  const [customDataType, setCustomDataType] =
    React.useState<FieldDefinitionEntry['dataType']>('string');
  const [customFieldType, setCustomFieldType] =
    React.useState<FieldDefinitionFieldType>('standard');

  // Build selected keys set for quick lookup
  const selectedKeys = React.useMemo(
    () => new Set(selectedFields.map((f) => f.key)),
    [selectedFields]
  );

  // Group candidates by category
  const groupedCandidates = React.useMemo(() => {
    if (!candidates) return [];

    const filtered = search
      ? candidates.filter(
          (c) =>
            c.key.toLowerCase().includes(search.toLowerCase()) ||
            c.label.toLowerCase().includes(search.toLowerCase())
        )
      : candidates;

    const groups = new Map<string, FieldDefinitionEntry[]>();
    for (const item of filtered) {
      const existing = groups.get(item.category) ?? [];
      groups.set(item.category, [...existing, item]);
    }

    return CATEGORY_ORDER
      .filter((cat) => groups.has(cat))
      .map((cat) => ({
        category: cat,
        items: groups.get(cat)!,
      }));
  }, [candidates, search]);

  // Toggle a single field
  const handleToggleField = React.useCallback(
    (candidate: FieldDefinitionEntry) => {
      if (selectedKeys.has(candidate.key)) {
        onChange(selectedFields.filter((f) => f.key !== candidate.key));
      } else {
        onChange([...selectedFields, { ...candidate }]);
      }
    },
    [selectedFields, selectedKeys, onChange]
  );

  // Toggle all fields in a category
  const handleToggleCategory = React.useCallback(
    (group: GroupedCandidate) => {
      const groupKeys = new Set(group.items.map((i) => i.key));
      const allSelected = group.items.every((i) => selectedKeys.has(i.key));

      if (allSelected) {
        // Deselect all in this category
        onChange(selectedFields.filter((f) => !groupKeys.has(f.key)));
      } else {
        // Select all missing in this category
        const toAdd = group.items.filter((i) => !selectedKeys.has(i.key));
        onChange([...selectedFields, ...toAdd]);
      }
    },
    [selectedFields, selectedKeys, onChange]
  );

  // Collapse/expand category
  const toggleCollapsed = React.useCallback((category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  // Update a selected field's properties
  const handleUpdateField = React.useCallback(
    (updated: FieldDefinitionEntry) => {
      onChange(
        selectedFields.map((f) => (f.key === updated.key ? updated : f))
      );
    },
    [selectedFields, onChange]
  );

  // Remove a selected field
  const handleRemoveField = React.useCallback(
    (key: string) => {
      onChange(selectedFields.filter((f) => f.key !== key));
    },
    [selectedFields, onChange]
  );

  // Add custom field
  const handleAddCustom = React.useCallback(() => {
    if (!customKey || !customLabel) return;
    const entry: FieldDefinitionEntry = {
      key: customKey,
      label: customLabel,
      category: customCategory,
      dataType: customDataType,
      required: false,
      aliases: [],
      fieldType: customFieldType,
    };
    onChange([...selectedFields, entry]);
    setCustomKey('');
    setCustomLabel('');
    setShowCustomForm(false);
  }, [
    customKey,
    customLabel,
    customCategory,
    customDataType,
    customFieldType,
    selectedFields,
    onChange,
  ]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header: search + count */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('form.fieldPicker.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Badge variant="secondary">
          {t('form.fieldPicker.selected', { count: selectedFields.length })}
        </Badge>
      </div>

      {/* Candidate groups */}
      <div className="relative border rounded-md divide-y max-h-[400px] overflow-y-auto">
        {groupedCandidates.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t('form.fieldPicker.noResults')}
          </div>
        ) : (
          groupedCandidates.map((group) => {
            const isCollapsed = collapsedCategories.has(group.category);
            const allSelected = group.items.every((i) =>
              selectedKeys.has(i.key)
            );
            const someSelected =
              !allSelected &&
              group.items.some((i) => selectedKeys.has(i.key));

            return (
              <div key={group.category}>
                {/* Category header */}
                <div className="flex items-center gap-2 px-3 py-2 bg-muted sticky top-0 z-10">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => toggleCollapsed(group.category)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </Button>
                  <Checkbox
                    checked={someSelected ? 'indeterminate' : allSelected}
                    onCheckedChange={() => handleToggleCategory(group)}
                  />
                  <span className="text-sm font-medium">
                    {t(
                      `category.${group.category}` as Parameters<typeof t>[0]
                    )}
                  </span>
                  <Badge variant="outline" className="text-xs ml-auto">
                    {group.items.filter((i) => selectedKeys.has(i.key)).length}/
                    {group.items.length}
                  </Badge>
                </div>

                {/* Category items */}
                {!isCollapsed && (
                  <div className="divide-y">
                    {group.items.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center gap-3 px-3 py-2 pl-12 hover:bg-muted/30"
                      >
                        <Checkbox
                          checked={selectedKeys.has(item.key)}
                          onCheckedChange={() => handleToggleField(item)}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm">{item.label}</span>
                          <span className="text-xs text-muted-foreground ml-2 font-mono">
                            {item.key}
                          </span>
                        </div>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {t(
                            `dataType.${item.dataType}` as Parameters<
                              typeof t
                            >[0]
                          )}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Selected fields editor */}
      {selectedFields.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            {t('form.fieldPicker.selected', { count: selectedFields.length })}
          </h4>
          <div className="space-y-2">
            {selectedFields.map((field) => (
              <FieldEntryEditor
                key={field.key}
                entry={field}
                onChange={handleUpdateField}
                onRemove={() => handleRemoveField(field.key)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Add custom field */}
      {!showCustomForm ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowCustomForm(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t('form.fieldPicker.addCustom')}
        </Button>
      ) : (
        <div className="border rounded-md p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t('form.fieldPicker.customFieldKey')}
              </label>
              <Input
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="custom_field"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t('form.fieldPicker.customFieldLabel')}
              </label>
              <Input
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="Custom Field"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t('form.fieldPicker.customFieldCategory')}
              </label>
              <Select
                value={customCategory}
                onValueChange={setCustomCategory}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_ORDER.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {t(`category.${cat}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t('form.fieldPicker.customFieldDataType')}
              </label>
              <Select
                value={customDataType}
                onValueChange={(v) =>
                  setCustomDataType(v as FieldDefinitionEntry['dataType'])
                }
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATA_TYPES.map((dt) => (
                    <SelectItem key={dt} value={dt}>
                      {t(`dataType.${dt}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t('form.fieldEntry.fieldType')}
              </label>
              <Select
                value={customFieldType}
                onValueChange={(v) =>
                  setCustomFieldType(v as FieldDefinitionFieldType)
                }
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">
                    {t('form.fieldEntry.fieldTypeStandard')}
                  </SelectItem>
                  <SelectItem value="lineItem">
                    {t('form.fieldEntry.fieldTypeLineItem')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleAddCustom}
              disabled={!customKey || !customLabel || selectedKeys.has(customKey)}
            >
              {t('form.fieldPicker.customFieldAdd')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowCustomForm(false)}
            >
              {t('form.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
