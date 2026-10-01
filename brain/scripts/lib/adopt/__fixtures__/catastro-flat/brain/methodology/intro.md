# Metodología Brain — Introducción

> **Nota:** Este documento es una traducción al español del archivo canónico en inglés
> `brain/core/methodology/intro.md`. Las actualizaciones de Brain reemplazarán este
> archivo con la versión original en inglés; consulte `brain/project/` para
> personalizaciones propias del equipo.

## ¿Qué es la Metodología Brain?

La metodología Brain proporciona una organización estructurada para la gestión del
conocimiento en equipos de desarrollo de software. Está diseñada para facilitar la
adopción de convenciones compartidas sin imponer restricciones innecesarias al flujo
de trabajo del equipo.

Cada equipo que adopta Brain trabaja con dos capas diferenciadas:

- **Núcleo** (`brain/core/`): documentos gestionados por Brain y actualizados en
  cada nueva versión del paquete.
- **Proyecto** (`brain/project/`): documentos propios del equipo, que Brain nunca
  modifica.

## ¿Cómo Funciona?

Brain utiliza una lista de rutas gestionadas (`managed-paths.mjs`) para determinar
qué archivos son responsabilidad del paquete y cuáles pertenecen al equipo. Durante
`brain:upgrade`, solo se actualizan los archivos declarados como `managed`.

### Resolución de Conflictos

Cuando un archivo gestionado difiere entre la versión instalada y la última versión
de Brain, el instalador notifica al equipo sin sobreescribir nada de forma silenciosa.
Las decisiones de actualización quedan a cargo del equipo.

## Convenciones Adicionales

¡Recuerde que cada proyecto tiene sus particularidades! Las convenciones descritas
aquí son una guía compartida, no una imposición. Si alguna convención no se adapta
a su contexto, documéntela en `brain/project/decisions/` con el razonamiento
correspondiente.

## Referencias

- `brain/core/managed-paths.mjs`: lista de rutas gestionadas
- `brain/project/README.md`: punto de entrada para la documentación del proyecto
- ADR-0003: decisión de arquitectura sobre el sistema de rutas gestionadas
