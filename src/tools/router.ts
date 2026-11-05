/**
 * Tool routing and handler coordination
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { DiagnosticsClient } from '../diagnostics/client.js';
import type { AttributePatch, FoundryClient, WallType } from '../foundry/client.js';
import type { HeadlessGmSession } from '../foundry/headless-gm-session.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import type {
  ActorEffectChangeInput,
  ActorEffectDurationInput,
  ActorItemCreateSource,
  DocumentVisibility,
  JournalPageCreateSource,
  OWNERSHIP_LEVELS,
} from '../foundry/types.js';
import type { DiagnosticSystem } from '../utils/diagnostics.js';
import { logger } from '../utils/logger.js';
import type { ToolContext, ToolResult } from './base.js';
import {
  handleCreateFullActor,
  handleCreateWorldActor,
  handleDeleteWorldActor,
  handleUpdateActorAttribute,
} from './handlers/actor-mutations.js';
import {
  handleGetActorDetails,
  handleGetActorInventory,
  handleSearchActors,
} from './handlers/actors.js';
import { handleGetChatMessages } from './handlers/chat.js';
import { handleSendChatMessage } from './handlers/chat-mutations.js';
import { handleGetCombatState } from './handlers/combat.js';
import {
  handleEndCombat,
  handleNextTurn,
  handleSetInitiative,
  handleStartCombat,
} from './handlers/combat-mutations.js';
import { handleSearchCompendium } from './handlers/compendium.js';
import {
  type HealthRuntime,
  handleDiagnoseErrors,
  handleGetHealthStatus,
  handleGetRecentLogs,
  handleGetSystemHealth,
  handleSearchLogs,
} from './handlers/diagnostics.js';
// Import all tool handlers
import { handleRollDice } from './handlers/dice.js';
import {
  handleCreateActorEffect,
  handleDeleteActorEffect,
  handleListActorEffects,
  handleUpdateActorEffect,
} from './handlers/effects.js';
import { handleWatchEvents } from './handlers/events.js';
import { handleGenerateLoot, handleGenerateNPC, handleLookupRule } from './handlers/generation.js';
import {
  handleCreateActorItem,
  handleDeleteActorItem,
  handleUpdateActorItem,
} from './handlers/item-mutations.js';
import { handleSearchItems } from './handlers/items.js';
import {
  handleAddJournalPage,
  handleCreateJournalEntry,
  handleDeleteJournalEntry,
  handleUpdateJournalEntry,
  handleUpdateJournalPage,
  type JournalPageUpdateMode,
} from './handlers/journal-mutations.js';
import { handleGetJournal, handleSearchJournals } from './handlers/journals.js';
import {
  handleCaptureScene,
  handleGetDocumentSchema,
  handleGetTargets,
  handleImportCompendiumActor,
  handlePingCanvas,
  handleRollAndPost,
  handleSearchCompendiumContent,
  handleSetPause,
  handleSetTarget,
  handleUploadAsset,
} from './handlers/module-bridge.js';
import {
  handleCreateDrawing,
  handleCreateLight,
  handleCreateNote,
  handleCreateRegion,
  handleCreateSound,
  handleCreateTemplate,
  handleDeleteDrawing,
  handleDeleteLight,
  handleDeleteNote,
  handleDeleteRegion,
  handleDeleteSound,
  handleDeleteTemplate,
  handleUpdateLight,
} from './handlers/placeable-mutations.js';
import { handleReadResource } from './handlers/resources.js';
import {
  handleCreateRollTable,
  handleDeleteRollTable,
  handleListRollTables,
  handleRollTable,
} from './handlers/roll-tables.js';
import {
  handleCreateScene,
  handleDeleteScene,
  handleResetFog,
  handleSetSceneLighting,
  handleSetSceneWeather,
  handleSwitchScene,
} from './handlers/scene-mutations.js';
import {
  handleFindOpenCells,
  handleGetSceneInfo,
  handleListDrawings,
  handleListLights,
  handleListNotes,
  handleListRegions,
  handleListSceneAssets,
  handleListSounds,
  handleListTemplates,
  handleListTiles,
  handleListTokens,
  handleListWalls,
} from './handlers/scenes.js';
import { handleGetWorldSetting, handleSetWorldSetting } from './handlers/settings.js';
import { handleCreateTile, handleDeleteTile } from './handlers/tile-mutations.js';
import {
  handleApplyStatusEffect,
  handleDeleteToken,
  handleMoveToken,
  handleMoveTokenPathfind,
  handleMoveTokens,
  handleSpawnToken,
  handleUpdateTokenVision,
} from './handlers/token-mutations.js';
import { handleGetUsers, handleSetUserRole } from './handlers/users.js';
import {
  handleCreateWall,
  handleDeleteWall,
  handleSetDoorState,
} from './handlers/wall-mutations.js';
import {
  handleGetWorldSummary,
  handleRefreshWorldData,
  handleSearchWorld,
} from './handlers/world.js';
import {
  handleCreateFolder,
  handleCreateMacro,
  handleCreatePlaylist,
  handleDeleteMacro,
  handleDeletePlaylist,
  handleListFolders,
  handleListMacros,
  handleListPlaylists,
  handleSetDocumentOwnership,
  handleSetPlaylistState,
} from './handlers/world-documents.js';
import { toolRegistry } from './registry.js';

/**
 * Routes tool requests to appropriate handlers
 */
export async function routeToolRequest(
  name: string,
  args: Record<string, unknown>,
  foundryClient: FoundryClient,
  diagnosticsClient: DiagnosticsClient,
  diagnosticSystem: DiagnosticSystem,
  moduleBridge: ModuleBridge | null = null,
  headlessGmSession: HeadlessGmSession | null = null,
  healthRuntime: HealthRuntime = {},
): Promise<ToolResult> {
  logger.debug(`Routing tool request: ${name}`, { args });

  // Try the new registry system first
  if (toolRegistry.has(name)) {
    const context: ToolContext = {
      foundryClient,
      diagnosticsClient,
      diagnosticSystem,
    };

    try {
      return await toolRegistry.execute(name, args, context);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  switch (name) {
    // Dice tools
    case 'roll_dice':
      if (!('formula' in args) || typeof args.formula !== 'string') {
        throw new Error('Missing required parameter: formula');
      }
      return handleRollDice(args as { formula: string; reason?: string }, foundryClient);

    // Actor tools
    case 'search_actors':
      return handleSearchActors(args, foundryClient);
    case 'get_actor_details':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      return handleGetActorDetails(args as { actorId: string }, foundryClient);
    case 'get_actor_inventory':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      return handleGetActorInventory(args as { actorId: string }, foundryClient);

    // Actor mutation tools (laurigates/foundryvtt-mcp#143) — WRITE via the Socket.IO modifyDocument
    // protocol (foundryClient); require FOUNDRY_WRITE_ENABLED=true + a GM user.
    case 'update_actor_attributes':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('patch' in args) || typeof args.patch !== 'object' || args.patch === null) {
        throw new Error('Missing required parameter: patch');
      }
      return handleUpdateActorAttribute(
        args as { actorId: string; patch: AttributePatch },
        foundryClient,
      );
    case 'create_world_actor':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('type' in args) || typeof args.type !== 'string') {
        throw new Error('Missing required parameter: type');
      }
      return handleCreateWorldActor(
        args as { name: string; type: string; system?: Record<string, unknown>; folder?: string },
        foundryClient,
      );
    case 'create_full_actor':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('type' in args) || typeof args.type !== 'string') {
        throw new Error('Missing required parameter: type');
      }
      return handleCreateFullActor(
        args as {
          name: string;
          type: string;
          system?: Record<string, unknown>;
          folder?: string;
          items?: Array<{ name: string; type: string; system?: Record<string, unknown> }>;
        },
        foundryClient,
      );
    case 'delete_world_actor':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      return handleDeleteWorldActor(args as { actorId: string }, foundryClient);

    // Item tools
    case 'search_items':
      return handleSearchItems(args, foundryClient);

    // Compendium tools (laurigates/foundryvtt-mcp#144)
    case 'search_compendium':
      if (!('query' in args) || typeof args.query !== 'string') {
        throw new Error('Missing required parameter: query');
      }
      return handleSearchCompendium(
        args as {
          query: string;
          filters?: {
            compendiumId?: string;
            packType?: string;
            itemType?: string;
            spellLevel?: number;
            source?: string;
          };
          limit?: number;
          cursor?: string;
        },
        foundryClient,
      );

    // Item mutation tools (WRITE) — Socket.IO modifyDocument protocol
    // (foundryClient); require FOUNDRY_WRITE_ENABLED=true + a GM user.
    case 'create_actor_item':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('source' in args) || typeof args.source !== 'object' || args.source === null) {
        throw new Error('Missing required parameter: source');
      }
      return handleCreateActorItem(
        args as { actorId: string; source: ActorItemCreateSource },
        foundryClient,
        moduleBridge,
      );
    case 'update_actor_item':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('itemId' in args) || typeof args.itemId !== 'string') {
        throw new Error('Missing required parameter: itemId');
      }
      if (!('patch' in args) || typeof args.patch !== 'object' || args.patch === null) {
        throw new Error('Missing required parameter: patch');
      }
      return handleUpdateActorItem(
        args as { actorId: string; itemId: string; patch: Record<string, unknown> },
        foundryClient,
      );
    case 'delete_actor_item':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('itemId' in args) || typeof args.itemId !== 'string') {
        throw new Error('Missing required parameter: itemId');
      }
      return handleDeleteActorItem(args as { actorId: string; itemId: string }, foundryClient);

    // Scene tools
    case 'get_scene_info':
      return handleGetSceneInfo(args, foundryClient);
    case 'create_scene':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('backgroundSrc' in args) || typeof args.backgroundSrc !== 'string') {
        throw new Error('Missing required parameter: backgroundSrc');
      }
      return handleCreateScene(
        args as {
          name: string;
          backgroundSrc: string;
          width?: number;
          height?: number;
          gridSize?: number;
          gridType?: number;
          gridDistance?: number;
          gridUnits?: string;
          padding?: number;
          backgroundColor?: string;
          activate?: boolean;
        },
        foundryClient,
      );
    case 'switch_scene':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      return handleSwitchScene(args as { sceneId: string }, foundryClient);
    case 'delete_scene':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      return handleDeleteScene(args as { sceneId: string }, foundryClient);
    case 'set_scene_lighting':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      return handleSetSceneLighting(
        args as {
          sceneId: string;
          darkness?: number;
          globalLight?: boolean;
          globalLightThreshold?: number;
        },
        foundryClient,
      );
    case 'reset_fog':
      return handleResetFog(args as { sceneId?: string }, foundryClient);
    case 'set_scene_weather':
      if (!('weather' in args) || typeof args.weather !== 'string') {
        throw new Error('Missing required parameter: weather');
      }
      return handleSetSceneWeather(args as { weather: string; sceneId?: string }, foundryClient);

    // Tile read tools
    case 'list_scene_assets':
      return handleListSceneAssets(
        args as { subdir?: string; query?: string; limit?: number },
        foundryClient,
      );
    case 'list_tiles':
      return handleListTiles(args as { sceneId?: string }, foundryClient);
    case 'find_open_cells':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      return handleFindOpenCells(args as { sceneId: string; limit?: number }, foundryClient);

    // Tile mutation tools
    case 'create_tile':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      if (!('src' in args) || typeof args.src !== 'string') {
        throw new Error('Missing required parameter: src');
      }
      return handleCreateTile(
        args as {
          sceneId: string;
          src: string;
          x?: number;
          y?: number;
          gridCol?: number;
          gridRow?: number;
          width?: number;
          height?: number;
          rotation?: number;
          elevation?: number;
          hidden?: boolean;
          allowWallOverlap?: boolean;
        },
        foundryClient,
      );
    case 'delete_tile':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      if (!('tileId' in args) || typeof args.tileId !== 'string') {
        throw new Error('Missing required parameter: tileId');
      }
      return handleDeleteTile(args as { sceneId: string; tileId: string }, foundryClient);

    // Wall (structural) tools
    case 'list_walls':
      return handleListWalls(args as { sceneId?: string }, foundryClient);
    case 'create_wall':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      return handleCreateWall(
        args as {
          sceneId: string;
          x1?: number;
          y1?: number;
          x2?: number;
          y2?: number;
          fromCol?: number;
          fromRow?: number;
          toCol?: number;
          toRow?: number;
          type?: WallType;
        },
        foundryClient,
      );
    case 'delete_wall':
      if (!('sceneId' in args) || typeof args.sceneId !== 'string') {
        throw new Error('Missing required parameter: sceneId');
      }
      if (!('wallId' in args) || typeof args.wallId !== 'string') {
        throw new Error('Missing required parameter: wallId');
      }
      return handleDeleteWall(args as { sceneId: string; wallId: string }, foundryClient);
    case 'set_door_state':
      if (!('wallId' in args) || typeof args.wallId !== 'string') {
        throw new Error('Missing required parameter: wallId');
      }
      if (!('state' in args) || typeof args.state !== 'number') {
        throw new Error('Missing required parameter: state');
      }
      return handleSetDoorState(
        args as { wallId: string; state: 0 | 1 | 2; sceneId?: string },
        foundryClient,
      );

    // Placeable tools (read)
    case 'list_lights':
      return handleListLights(args as { sceneId?: string }, foundryClient);
    case 'list_sounds':
      return handleListSounds(args as { sceneId?: string }, foundryClient);
    case 'list_notes':
      return handleListNotes(args as { sceneId?: string }, foundryClient);
    case 'list_drawings':
      return handleListDrawings(args as { sceneId?: string }, foundryClient);
    case 'list_templates':
      return handleListTemplates(args as { sceneId?: string }, foundryClient);
    case 'list_regions':
      return handleListRegions(args as { sceneId?: string }, foundryClient);

    // Placeable mutation tools (WRITE)
    case 'create_light':
      return handleCreateLight(
        args as {
          sceneId?: string;
          x?: number;
          y?: number;
          gridCol?: number;
          gridRow?: number;
          dim?: number;
          bright?: number;
          color?: string;
          angle?: number;
          rotation?: number;
          animationType?: string;
          animationSpeed?: number;
          animationIntensity?: number;
          walls?: boolean;
          vision?: boolean;
          hidden?: boolean;
        },
        foundryClient,
      );
    case 'update_light':
      if (!('lightId' in args) || typeof args.lightId !== 'string') {
        throw new Error('Missing required parameter: lightId');
      }
      return handleUpdateLight(
        args as {
          lightId: string;
          sceneId?: string;
          x?: number;
          y?: number;
          dim?: number;
          bright?: number;
          color?: string;
          angle?: number;
          rotation?: number;
          walls?: boolean;
          vision?: boolean;
          hidden?: boolean;
        },
        foundryClient,
      );
    case 'delete_light':
      if (!('lightId' in args) || typeof args.lightId !== 'string') {
        throw new Error('Missing required parameter: lightId');
      }
      return handleDeleteLight(args as { lightId: string; sceneId?: string }, foundryClient);
    case 'create_sound':
      if (!('path' in args) || typeof args.path !== 'string') {
        throw new Error('Missing required parameter: path');
      }
      return handleCreateSound(
        args as {
          path: string;
          sceneId?: string;
          x?: number;
          y?: number;
          gridCol?: number;
          gridRow?: number;
          radius?: number;
          volume?: number;
          repeat?: boolean;
          walls?: boolean;
          easing?: boolean;
          hidden?: boolean;
        },
        foundryClient,
      );
    case 'delete_sound':
      if (!('soundId' in args) || typeof args.soundId !== 'string') {
        throw new Error('Missing required parameter: soundId');
      }
      return handleDeleteSound(args as { soundId: string; sceneId?: string }, foundryClient);
    case 'create_note':
      return handleCreateNote(
        args as {
          sceneId?: string;
          entryId?: string;
          pageId?: string;
          x?: number;
          y?: number;
          gridCol?: number;
          gridRow?: number;
          text?: string;
          iconSize?: number;
          fontSize?: number;
          textAnchor?: number;
          global?: boolean;
        },
        foundryClient,
      );
    case 'delete_note':
      if (!('noteId' in args) || typeof args.noteId !== 'string') {
        throw new Error('Missing required parameter: noteId');
      }
      return handleDeleteNote(args as { noteId: string; sceneId?: string }, foundryClient);
    case 'create_drawing':
      if (!('x' in args) || typeof args.x !== 'number') {
        throw new Error('Missing required parameter: x');
      }
      if (!('y' in args) || typeof args.y !== 'number') {
        throw new Error('Missing required parameter: y');
      }
      return handleCreateDrawing(
        args as {
          shape?: 'r' | 'c' | 'e' | 'p';
          x: number;
          y: number;
          sceneId?: string;
          width?: number;
          height?: number;
          radius?: number;
          points?: number[];
          rotation?: number;
          strokeColor?: string;
          strokeWidth?: number;
          fillType?: 0 | 1 | 2;
          fillColor?: string;
          fillAlpha?: number;
          text?: string;
          fontSize?: number;
          hidden?: boolean;
          locked?: boolean;
        },
        foundryClient,
      );
    case 'delete_drawing':
      if (!('drawingId' in args) || typeof args.drawingId !== 'string') {
        throw new Error('Missing required parameter: drawingId');
      }
      return handleDeleteDrawing(args as { drawingId: string; sceneId?: string }, foundryClient);
    case 'create_template':
      if (!('distance' in args) || typeof args.distance !== 'number') {
        throw new Error('Missing required parameter: distance');
      }
      return handleCreateTemplate(
        args as {
          distance: number;
          sceneId?: string;
          t?: 'circle' | 'cone' | 'rect' | 'ray';
          x?: number;
          y?: number;
          gridCol?: number;
          gridRow?: number;
          direction?: number;
          angle?: number;
          width?: number;
          borderColor?: string;
          fillColor?: string;
          hidden?: boolean;
        },
        foundryClient,
      );
    case 'delete_template':
      if (!('templateId' in args) || typeof args.templateId !== 'string') {
        throw new Error('Missing required parameter: templateId');
      }
      return handleDeleteTemplate(args as { templateId: string; sceneId?: string }, foundryClient);
    case 'create_region':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      return handleCreateRegion(
        args as {
          name: string;
          sceneId?: string;
          color?: string;
          visibility?: number;
          elevation?: { bottom?: number; top?: number };
          shapes?: Array<
            | { type: 'rectangle'; x: number; y: number; width: number; height: number }
            | { type: 'circle'; x: number; y: number; radius: number }
            | { type: 'polygon'; points: number[] }
          >;
          behaviors?: Array<{
            type: string;
            system?: Record<string, unknown>;
            disabled?: boolean;
          }>;
        },
        foundryClient,
      );
    case 'delete_region':
      if (!('regionId' in args) || typeof args.regionId !== 'string') {
        throw new Error('Missing required parameter: regionId');
      }
      return handleDeleteRegion(args as { regionId: string; sceneId?: string }, foundryClient);

    // Combat tools
    case 'get_combat_state':
      return handleGetCombatState(args, foundryClient);

    // Combat mutation tools (FR-018, WRITE — require FOUNDRY_WRITE_ENABLED)
    case 'next_turn':
      return handleNextTurn(args as { skipDefeated?: boolean }, foundryClient);
    case 'end_combat':
      return handleEndCombat(args, foundryClient);
    case 'set_initiative':
      if (!('combatantId' in args) || typeof args.combatantId !== 'string') {
        throw new Error('Missing required parameter: combatantId');
      }
      if (!('initiative' in args) || typeof args.initiative !== 'number') {
        throw new Error('Missing required parameter: initiative');
      }
      return handleSetInitiative(
        args as { combatantId: string; initiative: number; combatId?: string },
        foundryClient,
      );
    case 'start_combat':
      return handleStartCombat(args as { tokenIds?: string[]; sceneId?: string }, foundryClient);

    // Token tools (read) — pure reads over cached worldData, no write gate.
    case 'list_tokens':
      return handleListTokens(args as { sceneId?: string }, foundryClient);

    // Token mutation tools (FR-019, WRITE — require FOUNDRY_WRITE_ENABLED)
    case 'move_token':
      if (!('tokenId' in args) || typeof args.tokenId !== 'string') {
        throw new Error('Missing required parameter: tokenId');
      }
      if (!('x' in args) || typeof args.x !== 'number') {
        throw new Error('Missing required parameter: x');
      }
      if (!('y' in args) || typeof args.y !== 'number') {
        throw new Error('Missing required parameter: y');
      }
      return handleMoveToken(
        args as { tokenId: string; x: number; y: number; sceneId?: string },
        foundryClient,
      );
    case 'apply_status_effect':
      if (!('tokenId' in args) || typeof args.tokenId !== 'string') {
        throw new Error('Missing required parameter: tokenId');
      }
      if (!('statusId' in args) || typeof args.statusId !== 'string') {
        throw new Error('Missing required parameter: statusId');
      }
      return handleApplyStatusEffect(
        args as { tokenId: string; statusId: string; active?: boolean; sceneId?: string },
        foundryClient,
      );
    case 'spawn_token':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('x' in args) || typeof args.x !== 'number') {
        throw new Error('Missing required parameter: x');
      }
      if (!('y' in args) || typeof args.y !== 'number') {
        throw new Error('Missing required parameter: y');
      }
      return handleSpawnToken(
        args as {
          actorId: string;
          x: number;
          y: number;
          sceneId?: string;
          name?: string;
          hidden?: boolean;
        },
        foundryClient,
      );
    case 'delete_token':
      if (!('tokenId' in args) || typeof args.tokenId !== 'string') {
        throw new Error('Missing required parameter: tokenId');
      }
      return handleDeleteToken(args as { tokenId: string; sceneId?: string }, foundryClient);
    case 'move_token_pathfind':
      if (!('tokenId' in args) || typeof args.tokenId !== 'string') {
        throw new Error('Missing required parameter: tokenId');
      }
      if (!('x' in args) || typeof args.x !== 'number') {
        throw new Error('Missing required parameter: x');
      }
      if (!('y' in args) || typeof args.y !== 'number') {
        throw new Error('Missing required parameter: y');
      }
      return handleMoveTokenPathfind(
        args as { tokenId: string; x: number; y: number; sceneId?: string; openDoors?: boolean },
        foundryClient,
      );
    case 'move_tokens':
      if (!('moves' in args) || !Array.isArray(args.moves)) {
        throw new Error('Missing required parameter: moves');
      }
      return handleMoveTokens(
        args as {
          moves: Array<{
            tokenId: string;
            x: number;
            y: number;
            sceneId?: string;
            pathfind?: boolean;
            openDoors?: boolean;
          }>;
        },
        foundryClient,
      );
    case 'update_token_vision':
      if (!('tokenId' in args) || typeof args.tokenId !== 'string') {
        throw new Error('Missing required parameter: tokenId');
      }
      return handleUpdateTokenVision(
        args as {
          tokenId: string;
          sceneId?: string;
          sightEnabled?: boolean;
          sightRange?: number;
          sightAngle?: number;
          visionMode?: string;
          lightDim?: number;
          lightBright?: number;
          lightColor?: string;
          lightAngle?: number;
          lightAnimationType?: string;
        },
        foundryClient,
      );

    // Chat tools
    case 'get_chat_messages':
      return handleGetChatMessages(args as { limit?: number }, foundryClient);
    case 'send_chat_message':
      if (!('content' in args) || typeof args.content !== 'string') {
        throw new Error('Missing required parameter: content');
      }
      return handleSendChatMessage(
        args as {
          content: string;
          speaker?: string;
          whisperTo?: string[];
          style?: 'ooc' | 'ic' | 'emote';
        },
        foundryClient,
      );

    // User tools
    case 'get_users':
      return handleGetUsers(args, foundryClient);
    case 'set_user_role':
      if (!('userId' in args) || typeof args.userId !== 'string') {
        throw new Error('Missing required parameter: userId');
      }
      if (!('role' in args) || typeof args.role !== 'string') {
        throw new Error('Missing required parameter: role');
      }
      return handleSetUserRole(args as { userId: string; role: string }, foundryClient);

    // Journal tools
    case 'search_journals':
      if (!('query' in args) || typeof args.query !== 'string') {
        throw new Error('Missing required parameter: query');
      }
      return handleSearchJournals(args as { query: string; limit?: number }, foundryClient);
    case 'get_journal':
      if (!('journalId' in args) || typeof args.journalId !== 'string') {
        throw new Error('Missing required parameter: journalId');
      }
      if ('raw' in args && args.raw !== undefined && typeof args.raw !== 'boolean') {
        throw new Error('Invalid parameter: raw must be a boolean');
      }
      return handleGetJournal(args as { journalId: string; raw?: boolean }, foundryClient);

    // Journal mutation tools (WRITE) — Socket.IO modifyDocument protocol
    // (foundryClient); require FOUNDRY_WRITE_ENABLED=true + a GM user.
    case 'create_journal_entry':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('pages' in args) || !Array.isArray(args.pages)) {
        throw new Error('Missing required parameter: pages');
      }
      return handleCreateJournalEntry(
        args as {
          name: string;
          pages: JournalPageCreateSource[];
          folder?: string;
          visibility?: DocumentVisibility;
        },
        foundryClient,
      );
    case 'update_journal_page':
      if (!('journalId' in args) || typeof args.journalId !== 'string') {
        throw new Error('Missing required parameter: journalId');
      }
      if (!('pageId' in args) || typeof args.pageId !== 'string') {
        throw new Error('Missing required parameter: pageId');
      }
      if (
        'expectedVersion' in args &&
        args.expectedVersion !== undefined &&
        typeof args.expectedVersion !== 'string'
      ) {
        throw new Error('Invalid parameter: expectedVersion must be a string');
      }
      return handleUpdateJournalPage(
        args as {
          journalId: string;
          pageId: string;
          mode?: JournalPageUpdateMode;
          expectedVersion?: string;
          name?: string;
          content?: string;
        },
        foundryClient,
      );
    case 'add_journal_page':
      if (!('journalId' in args) || typeof args.journalId !== 'string') {
        throw new Error('Missing required parameter: journalId');
      }
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('content' in args) || typeof args.content !== 'string') {
        throw new Error('Missing required parameter: content');
      }
      return handleAddJournalPage(
        args as { journalId: string; name: string; content: string },
        foundryClient,
      );
    case 'update_journal_entry':
      if (!('journalId' in args) || typeof args.journalId !== 'string') {
        throw new Error('Missing required parameter: journalId');
      }
      return handleUpdateJournalEntry(
        args as {
          journalId: string;
          name?: string;
          folder?: string;
          visibility?: DocumentVisibility;
        },
        foundryClient,
      );
    case 'delete_journal_entry':
      if (!('journalId' in args) || typeof args.journalId !== 'string') {
        throw new Error('Missing required parameter: journalId');
      }
      return handleDeleteJournalEntry(args as { journalId: string }, foundryClient);

    // Module-bridge tools (canvas-only; require the companion Foundry module)
    case 'capture_scene':
      return handleCaptureScene(args, moduleBridge);
    case 'get_document_schema':
      if (!('documentType' in args) || typeof args.documentType !== 'string') {
        throw new Error('Missing required parameter: documentType');
      }
      if (!('type' in args) || typeof args.type !== 'string') {
        throw new Error('Missing required parameter: type');
      }
      return handleGetDocumentSchema(
        args as { documentType: 'Actor' | 'Item'; type: string },
        moduleBridge,
      );
    case 'search_compendium_content':
      return handleSearchCompendiumContent(
        args as { query?: string; packType?: string; limit?: number },
        moduleBridge,
      );
    case 'roll_and_post':
      if (!('formula' in args) || typeof args.formula !== 'string') {
        throw new Error('Missing required parameter: formula');
      }
      return handleRollAndPost(
        args as {
          formula: string;
          flavor?: string;
          speakerAlias?: string;
          whisperTo?: string[];
          rollMode?: string;
        },
        moduleBridge,
      );
    case 'import_compendium_actor':
      if (!('compendiumId' in args) || typeof args.compendiumId !== 'string') {
        throw new Error('Missing required parameter: compendiumId');
      }
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      return handleImportCompendiumActor(
        args as { compendiumId: string; actorId: string; folderId?: string; name?: string },
        foundryClient,
        moduleBridge,
      );
    case 'set_target':
      if (!('tokenIds' in args) || !Array.isArray(args.tokenIds)) {
        throw new Error('Missing required parameter: tokenIds');
      }
      return handleSetTarget(
        args as { tokenIds: string[]; targeted?: boolean; replace?: boolean },
        moduleBridge,
      );
    case 'get_targets':
      return handleGetTargets(args, moduleBridge);
    case 'ping_canvas':
      if (!('x' in args) || typeof args.x !== 'number') {
        throw new Error('Missing required parameter: x');
      }
      if (!('y' in args) || typeof args.y !== 'number') {
        throw new Error('Missing required parameter: y');
      }
      return handlePingCanvas(args as { x: number; y: number; sceneId?: string }, moduleBridge);
    case 'set_pause':
      return handleSetPause(args as { paused?: boolean }, moduleBridge);
    case 'upload_asset':
      if (!('targetDir' in args) || typeof args.targetDir !== 'string') {
        throw new Error('Missing required parameter: targetDir');
      }
      if (!('filename' in args) || typeof args.filename !== 'string') {
        throw new Error('Missing required parameter: filename');
      }
      return handleUploadAsset(
        args as {
          targetDir: string;
          filename: string;
          contentBase64?: string;
          sourcePath?: string;
          mimeType?: string;
        },
        moduleBridge,
      );

    // World-event tools (read-only)
    case 'watch_events':
      return handleWatchEvents(
        args as {
          cursor?: string;
          waitMs?: number;
          limit?: number;
          kinds?: string[];
          types?: string[];
          actions?: string[];
          sceneId?: string;
          excludeSelf?: boolean;
        },
        foundryClient,
      );

    // World tools
    case 'search_world':
      if (!('query' in args) || typeof args.query !== 'string') {
        throw new Error('Missing required parameter: query');
      }
      return handleSearchWorld(args as { query: string; limit?: number }, foundryClient);
    case 'get_world_summary':
      return handleGetWorldSummary(args, foundryClient);
    case 'refresh_world_data':
      return handleRefreshWorldData(args, foundryClient);

    // Roll table tools
    case 'list_roll_tables':
      return handleListRollTables(args, foundryClient);
    case 'roll_table':
      if (!('tableId' in args) || typeof args.tableId !== 'string') {
        throw new Error('Missing required parameter: tableId');
      }
      return handleRollTable(args as { tableId: string }, foundryClient);
    case 'create_roll_table':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('results' in args) || !Array.isArray(args.results)) {
        throw new Error('Missing required parameter: results');
      }
      return handleCreateRollTable(
        args as {
          name: string;
          results: Array<{ text: string; weight?: number; range?: [number, number] }>;
          description?: string;
          formula?: string;
          replacement?: boolean;
          displayRoll?: boolean;
          folder?: string;
        },
        foundryClient,
      );
    case 'delete_roll_table':
      if (!('tableId' in args) || typeof args.tableId !== 'string') {
        throw new Error('Missing required parameter: tableId');
      }
      return handleDeleteRollTable(args as { tableId: string }, foundryClient);

    // World document tools (folders, macros, playlists)
    case 'list_folders':
      return handleListFolders(args as { type?: string }, foundryClient);
    case 'create_folder':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('type' in args) || typeof args.type !== 'string') {
        throw new Error('Missing required parameter: type');
      }
      return handleCreateFolder(
        args as {
          name: string;
          type: string;
          parent?: string;
          color?: string;
          sorting?: 'a' | 'm';
        },
        foundryClient,
      );
    case 'list_macros':
      return handleListMacros(args, foundryClient);
    case 'create_macro':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      if (!('type' in args) || typeof args.type !== 'string') {
        throw new Error('Missing required parameter: type');
      }
      if (!('command' in args) || typeof args.command !== 'string') {
        throw new Error('Missing required parameter: command');
      }
      return handleCreateMacro(
        args as {
          name: string;
          type: 'script' | 'chat';
          command: string;
          img?: string;
          folder?: string;
          scope?: 'global' | 'actors' | 'actor';
        },
        foundryClient,
      );
    case 'delete_macro':
      if (!('macroId' in args) || typeof args.macroId !== 'string') {
        throw new Error('Missing required parameter: macroId');
      }
      return handleDeleteMacro(args as { macroId: string }, foundryClient);
    case 'list_playlists':
      return handleListPlaylists(args, foundryClient);
    case 'create_playlist':
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      return handleCreatePlaylist(
        args as {
          name: string;
          description?: string;
          mode?: -1 | 0 | 1 | 2;
          channel?: 'music' | 'environment' | 'interface';
          fade?: number;
          folder?: string;
          sounds?: Array<{ name: string; path: string; volume?: number; repeat?: boolean }>;
        },
        foundryClient,
      );
    case 'set_playlist_state':
      if (!('playlistId' in args) || typeof args.playlistId !== 'string') {
        throw new Error('Missing required parameter: playlistId');
      }
      if (!('playing' in args) || typeof args.playing !== 'boolean') {
        throw new Error('Missing required parameter: playing');
      }
      return handleSetPlaylistState(
        args as {
          playlistId: string;
          playing: boolean;
          soundId?: string;
        },
        foundryClient,
      );
    case 'delete_playlist':
      if (!('playlistId' in args) || typeof args.playlistId !== 'string') {
        throw new Error('Missing required parameter: playlistId');
      }
      return handleDeletePlaylist(args as { playlistId: string }, foundryClient);
    case 'set_document_ownership':
      if (!('documentType' in args) || typeof args.documentType !== 'string') {
        throw new Error('Missing required parameter: documentType');
      }
      if (!('documentId' in args) || typeof args.documentId !== 'string') {
        throw new Error('Missing required parameter: documentId');
      }
      if (!('entries' in args) || !Array.isArray(args.entries)) {
        throw new Error('Missing required parameter: entries');
      }
      return handleSetDocumentOwnership(
        args as {
          documentType: 'Actor' | 'Item' | 'Scene' | 'JournalEntry' | 'RollTable' | 'Macro';
          documentId: string;
          entries: Array<{ target: string; level: keyof typeof OWNERSHIP_LEVELS }>;
        },
        foundryClient,
      );

    // Settings tools
    case 'get_world_setting':
      if (!('key' in args) || typeof args.key !== 'string') {
        throw new Error('Missing required parameter: key');
      }
      return handleGetWorldSetting(args as { key: string }, foundryClient);
    case 'set_world_setting':
      if (!('key' in args) || typeof args.key !== 'string') {
        throw new Error('Missing required parameter: key');
      }
      if (!('value' in args)) {
        throw new Error('Missing required parameter: value');
      }
      return handleSetWorldSetting(args as { key: string; value: unknown }, foundryClient);

    // Generation tools
    case 'generate_npc':
      return handleGenerateNPC(
        args as { level?: number; race?: string; class?: string },
        foundryClient,
      );
    case 'generate_loot':
      return handleGenerateLoot(
        args as { challengeRating?: number; treasureType?: string },
        foundryClient,
      );
    case 'lookup_rule':
      if (!('query' in args) || typeof args.query !== 'string') {
        throw new Error('Missing required parameter: query');
      }
      return handleLookupRule(args as { query: string }, foundryClient, moduleBridge);

    // Diagnostics tools (require REST API module)
    case 'get_recent_logs':
      return handleGetRecentLogs(args, diagnosticsClient);
    case 'search_logs':
      if (!('query' in args) || typeof args.query !== 'string') {
        throw new Error('Missing required parameter: query');
      }
      return handleSearchLogs(
        args as { query: string; level?: string; limit?: number },
        diagnosticsClient,
      );
    case 'get_system_health':
      return handleGetSystemHealth(args, diagnosticsClient);
    case 'diagnose_errors':
      return handleDiagnoseErrors(
        args as { category?: string; timeframe?: number },
        diagnosticsClient,
      );
    case 'get_health_status':
      return handleGetHealthStatus(
        args,
        foundryClient,
        diagnosticsClient,
        moduleBridge,
        headlessGmSession,
        healthRuntime,
      );

    // ActiveEffect tools (general-purpose; apply_status_effect above stays
    // the simpler idempotent status toggle)
    case 'create_actor_effect':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('name' in args) || typeof args.name !== 'string') {
        throw new Error('Missing required parameter: name');
      }
      return handleCreateActorEffect(
        args as {
          actorId: string;
          sceneId?: string;
          tokenId?: string;
          name: string;
          img?: string;
          description?: string;
          disabled?: boolean;
          statuses?: string[];
          duration?: ActorEffectDurationInput;
          changes?: ActorEffectChangeInput[];
        },
        foundryClient,
      );
    case 'update_actor_effect':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('effectId' in args) || typeof args.effectId !== 'string') {
        throw new Error('Missing required parameter: effectId');
      }
      return handleUpdateActorEffect(
        args as {
          actorId: string;
          sceneId?: string;
          tokenId?: string;
          effectId: string;
          name?: string;
          img?: string;
          description?: string;
          disabled?: boolean;
          statuses?: string[];
          duration?: ActorEffectDurationInput;
          changes?: ActorEffectChangeInput[];
        },
        foundryClient,
      );
    case 'delete_actor_effect':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      if (!('effectId' in args) || typeof args.effectId !== 'string') {
        throw new Error('Missing required parameter: effectId');
      }
      return handleDeleteActorEffect(
        args as { actorId: string; sceneId?: string; tokenId?: string; effectId: string },
        foundryClient,
      );
    case 'list_actor_effects':
      if (!('actorId' in args) || typeof args.actorId !== 'string') {
        throw new Error('Missing required parameter: actorId');
      }
      return handleListActorEffects(args as { actorId: string }, foundryClient);

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

/**
 * Routes resource requests to appropriate handlers
 */
export async function routeResourceRequest(
  uri: string,
  foundryClient: FoundryClient,
  diagnosticsClient: DiagnosticsClient,
) {
  logger.debug(`Routing resource request: ${uri}`);
  return handleReadResource(uri, foundryClient, diagnosticsClient);
}
