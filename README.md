# ytaPDF - Editor PDF Web

<div align="center">
  <img src="public/ytaPDF.png" alt="Logo" style="background-color: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); max-width: 100%;">
</div>

## Descripción General

ytaPDF es un editor de PDF web de alto rendimiento diseñado para proporcionar una experiencia de gestión de documentos fluida y eficiente. Construida en su totalidad con Svelte, PDF.js, Fabric.js y pdf-lib, la aplicación ofrece herramientas potentes para visualizar, organizar, modificar y exportar documentos PDF con máxima precisión directamente desde el navegador.

La arquitectura está diseñada con un enfoque en la modularidad, la gestión eficiente de la memoria y la velocidad de renderizado, asegurando un funcionamiento óptimo incluso con documentos de gran tamaño.

## Características Principales

* **Renderizado Avanzado de PDF:** Utiliza PDF.js para una visualización precisa y rápida de los documentos.
* **Exportación de Alta Precisión:** Utiliza pdf-lib para generar PDFs manteniendo coordenadas exactas, rotación, escalado de imágenes y preservando el formato de texto (negritas, cursivas) de manera idéntica al editor visual.
* **Organizador de Documentos:** Cuenta con una interfaz de cuadrícula con funcionalidad de arrastrar y soltar para reordenar, fusionar y gestionar páginas de uno o varios archivos PDF de manera intuitiva.
* **Edición sobre el Documento:** Capa de edición interactiva impulsada por Fabric.js versión 7, que permite realizar anotaciones, añadir imágenes y textos con modificaciones precisas.
* **Desplazamiento Continuo y Miniaturas:** Proporciona una navegación fluida a través de las páginas con retroalimentación visual instantánea y sincronización de desplazamiento.
* **Diseño 100% Responsivo:** Interfaz adaptable a cualquier tamaño de pantalla (móvil, tablet y escritorio), permitiendo gestionar y editar documentos cómodamente desde cualquier dispositivo.
* **Alto Rendimiento:** Implementa carga diferida (lazy loading), uso eficiente de canvas y gestión optimizada para manejar tareas complejas.

## Pila Tecnológica

* **Framework Frontend:** Svelte 5
* **Herramienta de Construcción:** Vite
* **Manipulación de Canvas:** Fabric.js v7
* **Procesamiento y Renderizado PDF:** PDF.js
* **Generación y Edición PDF:** pdf-lib
* **Lenguaje:** TypeScript

## Configuración e Instalación

### Requisitos Previos

* Node.js (se recomienda la versión 18 o superior)
* Gestor de paquetes npm, pnpm o yarn

### Pasos de Instalación

1. Clonar el repositorio en el entorno local.
2. Navegar al directorio raíz del proyecto.
3. Instalar las dependencias requeridas:

```bash
npm install
```

4. Iniciar el servidor de desarrollo:

```bash
npm run dev
```

5. Para compilar la versión de producción:

```bash
npm run build
```

## Vistas Previas

![Vista Previa 1](public/1.png)
![Vista Previa 2](public/2.png)
