import { readFileSync } from "fs";
import * as path from "path";
import {
  CancellationToken,
  ColorThemeKind,
  commands,
  Disposable,
  TextEditor,
  Uri,
  Webview,
  WebviewOptions,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  window,
} from "vscode";
import { DBTProjectContainer } from "../manifest/dbtProjectContainer";
import {
  ManifestCacheChangedEvent,
  ManifestCacheProjectAddedEvent,
} from "../manifest/event/manifestCacheChangedEvent";
import { provideSingleton } from "../utils";
import { TelemetryService } from "../telemetry";
import { AltimateRequest } from "../altimate";
import { NodeMetaData } from "../domain";

interface G6DataModel {
  nodes: {
    id: string;
    label: string;
  }[];
  edges: {
    source: string;
    target: string;
  }[];
}

const labelMaxWidth = 280;
const fontSize = 14;

const colors = {
  orange: "#EFB27B",
  blue: "#8DAAE8",
  green: "#8DE88E",
  black: "#000",
  purple: "#88447D",
  white: "#FFFFFF",
  softBlack: "#232b2b",
};

const nodeConfigurations: Record<string, any> = {
  children: {
    style: {
      lineWidth: 2,
      fill: colors.orange,
      stroke: colors.black,
      radius: 6,
    },
  },
  parents: {
    style: { lineWidth: 2, fill: colors.blue, stroke: colors.black, radius: 6 },
  },
  tests: {
    style: {
      lineWidth: 2,
      fill: colors.green,
      stroke: colors.black,
      radius: 6,
    },
  },
};

@provideSingleton(ModelGraphViewPanel)
export class ModelGraphViewPanel implements WebviewViewProvider {
  public static readonly viewType = "dbtPowerUser.ModelViewGraph";
  private _panel: WebviewView | undefined = undefined;
  private g6Data?: G6DataModel;
  private eventMap: Map<string, ManifestCacheProjectAddedEvent> = new Map();
  private _disposables: Disposable[] = [];
  private modelNode?: NodeMetaData;

  public constructor(
    private dbtProjectContainer: DBTProjectContainer,
    private altimate: AltimateRequest,
    private telemetry: TelemetryService,
  ) {
    dbtProjectContainer.onManifestChanged((event) =>
      this.onManifestCacheChanged(event),
    );
    window.onDidChangeActiveColorTheme(
      async (e) => {
        if (this._panel) {
          this.updateGraphStyle();
        }
      },
      null,
      this._disposables,
    );
    window.onDidChangeActiveTextEditor((event: TextEditor | undefined) => {
      if (event === undefined) {
        return;
      }
      this.g6Data = this.parseGraphData();
      if (this._panel) {
        this.transmitData(this.g6Data);
        this.updateGraphStyle();
      }
    });
  }

  private async transmitData(graphInfo: G6DataModel | undefined) {
    if (this._panel) {
      await this._panel.webview.postMessage({
        command: "renderGraph",
        graph: graphInfo,
      });
    }
  }

  private async updateGraphStyle() {
    const theme = [
      ColorThemeKind.Light,
      ColorThemeKind.HighContrastLight,
    ].includes(window.activeColorTheme.kind)
      ? "light"
      : "dark";
    if (this._panel) {
      await this._panel.webview.postMessage({
        command: "setStylesByTheme",
        theme: theme,
      });
    }
  }

  public async resolveWebviewView(
    panel: WebviewView,
    context: WebviewViewResolveContext,
    _token: CancellationToken,
  ) {
    this._panel = panel;
    this.setupWebviewOptions(context);
    this.renderWebviewView(context);
    this.setupWebviewHooks(context);
    this.g6Data = this.parseGraphData();
    this.transmitData(this.g6Data);
    this.updateGraphStyle();
  }

  private renderWebviewView(context: WebviewViewResolveContext) {
    const webview = this._panel!.webview!;
    this.g6Data = this.parseGraphData();
    webview.html = getHtml(webview, this.dbtProjectContainer.extensionUri);
  }

  private setupWebviewOptions(context: WebviewViewResolveContext) {
    this._panel!.title = "";
    this._panel!.description = "View dbt graph";
    this._panel!.webview.options = <WebviewOptions>{ enableScripts: true };
  }

  private setupWebviewHooks(context: WebviewViewResolveContext) {
    this._panel!.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "openFile":
            const { url } = message;
            if (!url) {
              return;
            }
            await commands.executeCommand("vscode.open", Uri.file(url), {
              preview: false,
              preserveFocus: true,
            });
          case "getColLevelLineage":
            this.telemetry.sendTelemetryEvent("getColLevelLineage");
            const currentFilePath = window.activeTextEditor?.document.uri;
            if (currentFilePath === undefined) {
              return;
            }
            const project =
              this.dbtProjectContainer.findDBTProject(currentFilePath);
            if (project === undefined || this.modelNode === undefined) {
              return;
            }
            // save compiled sql
            const compiledSql = await project.compileQuery(
              window.activeTextEditor!.document.getText(),
            );
            const modelName = path.basename(currentFilePath.fsPath, ".sql");
            const columnsInRelation =
              await project.getColumnsInRelation(modelName);

            if (!columnsInRelation) {
              // not sure if i should quit if i
              // cant get cols from db or just keep going
              return;
            }
            type colType = NodeMetaData["columns"];
            const columns: colType = Object.assign(
              {},
              ...columnsInRelation.map((column) => {
                const existing_column = this.modelNode!.columns[column.column];
                return {
                  [column.column]: {
                    name: column.column,
                    data_type: existing_column?.data_type || column.dtype,
                  },
                };
              }),
              // keeping this here to capture any stale columns as well.
              // these can be highlighted in the graph as not-used or no-lineage columns
              this.modelNode!.columns,
            );

            this.modelNode!.columns = columns;
            console.log(this.modelNode);

            const resp = await this.altimate.getColLevelLineage({
              model_name: this.modelNode?.alias,
              compiled_sql: compiledSql,
              model_node: this.modelNode,
            });
            console.log("Column level lineage response");
            console.log(resp);
        }
      },
      null,
      this._disposables,
    );
    const sendLineageViewEvent = () => {
      if (this._panel!.visible) {
        this.telemetry.sendTelemetryEvent("LineagePanelActive");
      }
    };
    sendLineageViewEvent();
    this._panel!.onDidChangeVisibility(sendLineageViewEvent);
  }

  private onManifestCacheChanged(event: ManifestCacheChangedEvent): void {
    event.added?.forEach((added) => {
      this.eventMap.set(added.projectRoot.fsPath, added);
    });
    event.removed?.forEach((removed) => {
      this.eventMap.delete(removed.projectRoot.fsPath);
    });
    this.g6Data = this.parseGraphData();
    if (this._panel) {
      this.transmitData(this.g6Data);
      this.updateGraphStyle();
    }
  }

  private parseGraphData = () => {
    if (window.activeTextEditor === undefined || this.eventMap === undefined) {
      return;
    }

    const currentFilePath = window.activeTextEditor.document.uri;
    const projectRootpath =
      this.dbtProjectContainer.getProjectRootpath(currentFilePath);
    if (projectRootpath === undefined) {
      return;
    }
    const event = this.eventMap.get(projectRootpath.fsPath);
    if (event === undefined) {
      return;
    }
    const { graphMetaMap, nodeMetaMap } = event;
    const fileName = path.basename(currentFilePath.fsPath, ".sql");
    this.modelNode = nodeMetaMap.get(fileName);
    return this.mapParentsAndChildren(graphMetaMap, fileName);
  };

  private mapParentsAndChildren = (graphMetaMap: any, fileName: string) => {
    let nodes: any[] = [];
    const edges: any[] = [];
    Object.keys(nodeConfigurations).forEach((type) => {
      const dependencyNodes = graphMetaMap[type];
      Array.from(dependencyNodes.keys()).forEach((key: any) => {
        if (key.endsWith(`.${fileName}`) && key.startsWith("model.")) {
          const node = dependencyNodes!.get(key)!;
          const currentNode = node;
          nodes = this.addCurrentNode(key, nodes);
          if (currentNode !== undefined) {
            currentNode.nodes.map(
              (childrenNode: {
                key: "string";
                label: "string";
                url: "string";
              }) => {
                let edge = { target: childrenNode.key, source: key };
                if (type === "parents") {
                  edge = { target: key, source: childrenNode.key };
                }
                edges.push(edge);
                nodes.push({
                  id: childrenNode.key,
                  label: fitLabelToNodeWidth(
                    childrenNode.label,
                    labelMaxWidth,
                    fontSize,
                  ),
                  style: nodeConfigurations[type].style,
                  url: childrenNode.url,
                });
              },
            );
          }
        }
      });
    });
    return { nodes, edges };
  };

  private addCurrentNode(nodeKey: string, nodes: any[]) {
    const nodeLabel: string = nodeKey.split(".").pop() || "";
    return [
      ...nodes,
      {
        id: nodeKey,
        label: fitLabelToNodeWidth(nodeLabel, labelMaxWidth, fontSize),
        labelCfg: { style: { fill: colors.white } },
        style: {
          fill: colors.purple,
          stroke: "black",
          radius: 6,
          lineWidth: 2,
        },
      },
    ];
  }
}

const calcStrLen = (label: string) => {
  let len = 0;
  for (let i = 0; i < label.length; i++) {
    if (label.charCodeAt(i) > 0 && label.charCodeAt(i) < 128) {
      len++;
    } else {
      len += 2;
    }
  }
  return len;
};

const fitLabelToNodeWidth = (
  label: string,
  maxWidth: number,
  fontSize: number,
) => {
  const fontWidth = fontSize * 1.3;
  maxWidth = maxWidth * 2;
  const width = calcStrLen(label) * fontWidth;
  const ellipsis = "…";
  if (width > maxWidth) {
    const actualLen = Math.floor((maxWidth - 10) / fontWidth);
    const result = label.substring(0, actualLen) + ellipsis;
    return result;
  }
  return label;
};

function getHtml(webview: Webview, extensionUri: Uri) {
  const indexPath = getUri(webview, extensionUri, [
    "lineage_panel",
    "index.html",
  ]);
  const scriptPath = getUri(webview, extensionUri, ["dist", "cll.js"]);
  const resourceDir = getUri(webview, extensionUri, ["lineage_panel"]);
  const theme = [
    ColorThemeKind.Light,
    ColorThemeKind.HighContrastLight,
  ].includes(window.activeColorTheme.kind)
    ? "light"
    : "dark";
  return readFileSync(indexPath.fsPath)
    .toString()
    .replace(/__ROOT__/g, resourceDir.toString())
    .replace(/__THEME__/g, theme)
    .replace(/__NONCE__/g, getNonce())
    .replace(/__CSPSOURCE__/g, webview.cspSource)
    .replace(/__CLL_URI__/g, scriptPath.toString());
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getUri(webview: Webview, extensionUri: Uri, pathList: string[]) {
  return webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList));
}
