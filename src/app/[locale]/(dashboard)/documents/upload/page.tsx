'use client'

/**
 * @fileoverview 文件上傳頁面（國際化版本）
 * @description
 *   提供文件上傳功能的頁面。
 *   支援拖放上傳、批量上傳和進度追蹤。
 *   支援選擇城市進行文件分類。
 *   支援完整的國際化。
 *
 * @module src/app/[locale]/(dashboard)/documents/upload/page
 * @author Development Team
 * @since Epic 2 - Story 2.1 (File Upload Interface & Validation)
 * @lastModified 2026-02-07
 *
 * @related
 *   - src/components/features/document/FileUploader.tsx - 上傳組件
 *   - src/app/api/documents/upload/route.ts - 上傳 API
 *   - messages/{locale}/documents.json - 翻譯檔案
 */

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { MapPin, Loader2 } from 'lucide-react'
import { FileUploader } from '@/components/features/document'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { useAccessibleCitiesGrouped } from '@/hooks/use-accessible-cities'

/**
 * 文件上傳頁面
 *
 * @component UploadPage
 * @description 文件上傳頁面，提供拖放上傳功能和城市選擇
 */
export default function UploadPage() {
  const t = useTranslations('documents')
  const [selectedCityCode, setSelectedCityCode] = useState<string>('')
  const { data: groupedCities, isLoading: isLoadingCities } = useAccessibleCitiesGrouped()

  // 從分組數據中創建城市代碼到名稱的映射
  const cityCodeToName = useMemo(() => {
    const map: Record<string, string> = {}
    groupedCities?.forEach((group) => {
      group.cities.forEach((city) => {
        map[city.code] = city.name
      })
    })
    return map
  }, [groupedCities])

  return (
    <div className="container mx-auto py-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('upload.title')}</CardTitle>
          <CardDescription>
            {t('upload.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 城市選擇器 */}
          <div className="space-y-2">
            <Label htmlFor="city-select">
              <span className="flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {t('upload.selectCity')} <span className="text-destructive">*</span>
              </span>
            </Label>
            <Select
              value={selectedCityCode}
              onValueChange={setSelectedCityCode}
              disabled={isLoadingCities}
            >
              <SelectTrigger id="city-select" className="w-full">
                <SelectValue placeholder={isLoadingCities ? t('upload.loading') : t('upload.selectCityPlaceholder')}>
                  {isLoadingCities ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('upload.loading')}
                    </span>
                  ) : selectedCityCode ? (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-4 w-4" />
                      {cityCodeToName[selectedCityCode]} ({selectedCityCode})
                    </span>
                  ) : (
                    t('upload.selectCityPlaceholder')
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {groupedCities?.map((group) => (
                  <SelectGroup key={group.region}>
                    <SelectLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {group.region}
                    </SelectLabel>
                    {group.cities.map((city) => (
                      <SelectItem key={city.code} value={city.code}>
                        <span className="flex items-center gap-2">
                          <MapPin className="h-3 w-3" />
                          {city.name} ({city.code})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {!selectedCityCode && !isLoadingCities && (
              <p className="text-sm text-muted-foreground">
                {t('upload.selectCityHint')}
              </p>
            )}
          </div>

          {/* 文件上傳器 */}
          {selectedCityCode ? (
            <FileUploader cityCode={selectedCityCode} />
          ) : (
            <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground">
              <MapPin className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>{t('upload.selectCityRequired')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
