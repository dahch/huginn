# Decisión 2026-11 — reposicionar Huginn

## Tesis

Huginn no vende «mejor ingeniería por defecto». Vende **fiabilidad operativa y
recuperabilidad**: cada incremento deja un recibo verificable (commits, árbol,
veredictos y coste) y un punto de reanudación. Para un delta pequeño, el valor
está en ese rastro, no en ejecutar más gates.

## Evidencia

- Corrección 42/42 frente a 36/42 del agente solo; las 6 derrotas del agente se
  concentran en un contrato sutil (abort composition).
- Requisitos latentes: 4/4 documentos frente a 0/4. Es el diferencial repetible.
- Empate en bordes, seguridad y no regresión del vecino.
- Mutación igual o peor que el agente solo (0.45–0.70 frente a 0.63–1.00).
- 5–6× tiempo de reloj y 40–70× líneas añadidas.
- `VALIDATE_STEP` bloqueó 11 de 16 incrementos y añadió ~50 % de líneas y ~40 %
  de tiempo sin ventaja medida.
- Los tokens no se midieron. Desde esta decisión el recibo declara `usage` real
  o `"unavailable"`, nunca lo omite.

## Límites del banco

Mide éxito de tarea, no operación: no probó sandbox, recibos, promoción,
reanudación ni auditoría. Varias celdas son n=1. Un oráculo oculto y una suite
del repositorio no capturan mantenibilidad ni coste humano. El banco no mide
tokens todavía; el runner y el analizador se adaptan, pero no se re-ejecutan las
59 celdas.

## Qué se conserva

- Los perfiles actuales (`huginn`, `sdd`, `odd`, `rdd`, `strict-tdd`, `quality`)
  y el defecto del CLI (`huginn`) siguen funcionando igual.
- Los gates no se borran: solo se ejecutan si un perfil los declara.
- La evidencia que puntúa sigue siendo el oráculo oculto y la suite del
  repositorio; los veredictos de Huginn no puntúan.

## Qué se congela

- No se añaden runtimes, fases, perfiles, MCPs ni capacidades nuevas.
- No se afirma una mejora general de calidad frente a un prompt directo.
- No se añade documentación fuera de este registro.

## Perfil `lite`

`EXECUTE → VERIFY → COMMIT_ALL`, con recibo. No es el defecto del CLI. Úsalo en
deltas pequeños ya cubiertos por la suite; elige `odd` si basta un commit
rápido, `rdd` si hace falta un gate y `quality` si seguridad, revisión o
documentación son el objetivo.

## Gates pesados

`pipelineFor` compone el pipeline únicamente desde `PROFILES[profile].phases`;
`--only-phase` no añade fases. Ninguna de `SPEC_AUDIT`, `VALIDATE_STEP`,
`TEST_MODULE`, `SECURE_CHECK`, `REVIEW` o `DOC_SYNC` se ejecuta por una ruta
ajena al perfil. Además de `quality`/`huginn`/`sdd`, los perfiles `odd`, `rdd` y
`strict-tdd` las declaran explícitamente; se mantienen para no romper su
comportamiento actual.

## Coste medible

El driver `pi` lee `getSessionStats()` y emite un evento `usage` por delta de
turno. El recibo guarda `{inputTokens, outputTokens, costUsd}` o
`"unavailable"`; `.harness/PROGRESS.md` muestra el acumulado. `huginn-bench`
añade `tokens` y `humanReviewMinutes` (este último, manual) al resultado.
