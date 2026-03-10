# 구현 계획안 - 공간 위상 및 스타일 불일치 문제 해결

## 문제 설명
이미지 생성 과정에서 보고된 다음 두 가지 문제를 해결합니다:
1. **위상 불일치 (Topology Mismatch)**: 생성된 평면도에서 원본 스케치에 지정된 것과 다른 위치에 방들이 배치되는 현상.
2. **스타일 불일치 (Style Mismatch)**: 생성된 평면도가 참조 템플릿의 시각적 스타일을 따르지 않는 현상.

## 원인 분석
이미지 생성 모델(`gemini-3.1-flash-image-preview`)이 입력 스케치를 '엄격한 공간 지도(Map)'가 아닌 단순한 '영감을 주는 참고 자료(Inspiration)'로 취급하고 있습니다. 또한, 최종 이미지 생성 프롬프트 문구("전문적이고 미니멀한 흑백 2D 평면 CAD 도면 생성")가 다소 포괄적이어서, 시스템 프롬프트에 정의된 구체적인 템플릿 스타일을 엄격히 모방하기보다는 AI 자체에 학습된 일반적인 CAD 스타일을 출력하게 됩니다.

## 제안하는 변경 사항

### 1. `src/App.tsx` (Step 2: 이미지 생성 프롬프트 업데이트)
#### [MODIFY] [App.tsx](file:///d:/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/CRETE/sketch-to-plan/src/App.tsx)
이미지 생성 모델로 전달되는 지시 사항을 강력하게 통제합니다.

**현재 `generationPrompt`:**
```typescript
const generationPrompt = \`\${finalPrompt}
Based on the following structural analysis:
\${structuralDriverRes}
Generate a professional, minimalist, black and white 2D top-down CAD floor plan.\`;
```

**제안하는 `generationPrompt` 업데이트:**
```typescript
const generationPrompt = \`\${finalPrompt}
Based on the following structural analysis:
\${structuralDriverRes}

CRITICAL TOPOLOGY INSTRUCTION: You MUST strictly maintain the exact 1:1 spatial arrangement, room positions, and adjacencies from the original input sketch. Do not move, rotate, or swap any rooms. 
CRITICAL STYLE INSTRUCTION: You MUST strictly mimic the visual style, line-weights, and minimalist aesthetics of the intended reference template. 
Generate a professional, minimalist, monochrome 2D top-down CAD floor plan adhering to the above absolute constraints.\`;
```

### 2. `protocol/prompt_sketch to plan 3.8.md` 및 `App.tsx` (시스템 프롬프트 업데이트)
- 시스템 프롬프트의 **[GUARD] Absolute Constraints (절대적 경계 - 10%)** 섹션 내에 위상 변경을 금지하고 템플릿 스타일 모방을 강제하는 명시적인 제약 조건을 추가합니다.
- **Strict Topology**: "절대로 스케치에 부여된 방의 위치나 배열 순서를 임의로 변경하지 마십시오. 스케치의 위상 구조(Topological Structure)를 1:1로 정확하게 맵핑해야 합니다."
- **Strict Template Adherence**: "임의의 인테리어 디자인이나 데코레이션을 추가하지 말고, 참조 도면(TEMPLATE)의 미니멀한 규격 및 선 굵기를 강제 적용하십시오."

## 검증 계획
1. **사용자 승인**: 이 계획안을 승인해 주시면 코드 업데이트를 진행하겠습니다.
2. **테스트**: 위상 구조(방 위치)가 1:1로 정확하게 매핑되는지, 결과물이 참조 템플릿의 뷰어 스타일과 일치하는지 새로운 스케치를 통해 직접 검증하실 수 있습니다.
