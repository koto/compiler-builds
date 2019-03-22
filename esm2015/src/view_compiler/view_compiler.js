/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { rendererTypeName, tokenReference, viewClassName } from '../compile_metadata';
import { BindingForm, EventHandlerVars, convertActionBinding, convertPropertyBinding, convertPropertyBindingBuiltins } from '../compiler_util/expression_converter';
import { ChangeDetectionStrategy } from '../core';
import { Identifiers } from '../identifiers';
import { LifecycleHooks } from '../lifecycle_reflector';
import { isNgContainer } from '../ml_parser/tags';
import * as o from '../output/output_ast';
import { convertValueToOutputAst } from '../output/value_util';
import { ElementAst, EmbeddedTemplateAst, NgContentAst, templateVisitAll } from '../template_parser/template_ast';
import { componentFactoryResolverProviderDef, depDef, lifecycleHookToNodeFlag, providerDef } from './provider_compiler';
const CLASS_ATTR = 'class';
const STYLE_ATTR = 'style';
const IMPLICIT_TEMPLATE_VAR = '\$implicit';
export class ViewCompileResult {
    constructor(viewClassVar, rendererTypeVar) {
        this.viewClassVar = viewClassVar;
        this.rendererTypeVar = rendererTypeVar;
    }
}
export class ViewCompiler {
    constructor(_reflector) {
        this._reflector = _reflector;
    }
    compileComponent(outputCtx, component, template, styles, usedPipes) {
        let embeddedViewCount = 0;
        const staticQueryIds = findStaticQueryIds(template);
        let renderComponentVarName = undefined;
        if (!component.isHost) {
            const template = component.template;
            const customRenderData = [];
            if (template.animations && template.animations.length) {
                customRenderData.push(new o.LiteralMapEntry('animation', convertValueToOutputAst(outputCtx, template.animations), true));
            }
            const renderComponentVar = o.variable(rendererTypeName(component.type.reference));
            renderComponentVarName = renderComponentVar.name;
            outputCtx.statements.push(renderComponentVar
                .set(o.importExpr(Identifiers.createRendererType2).callFn([new o.LiteralMapExpr([
                    new o.LiteralMapEntry('encapsulation', o.literal(template.encapsulation), false),
                    new o.LiteralMapEntry('styles', styles, false),
                    new o.LiteralMapEntry('data', new o.LiteralMapExpr(customRenderData), false)
                ])]))
                .toDeclStmt(o.importType(Identifiers.RendererType2), [o.StmtModifier.Final, o.StmtModifier.Exported]));
        }
        const viewBuilderFactory = (parent) => {
            const embeddedViewIndex = embeddedViewCount++;
            return new ViewBuilder(this._reflector, outputCtx, parent, component, embeddedViewIndex, usedPipes, staticQueryIds, viewBuilderFactory);
        };
        const visitor = viewBuilderFactory(null);
        visitor.visitAll([], template);
        outputCtx.statements.push(...visitor.build());
        return new ViewCompileResult(visitor.viewName, renderComponentVarName);
    }
}
const LOG_VAR = o.variable('_l');
const VIEW_VAR = o.variable('_v');
const CHECK_VAR = o.variable('_ck');
const COMP_VAR = o.variable('_co');
const EVENT_NAME_VAR = o.variable('en');
const ALLOW_DEFAULT_VAR = o.variable(`ad`);
class ViewBuilder {
    constructor(reflector, outputCtx, parent, component, embeddedViewIndex, usedPipes, staticQueryIds, viewBuilderFactory) {
        this.reflector = reflector;
        this.outputCtx = outputCtx;
        this.parent = parent;
        this.component = component;
        this.embeddedViewIndex = embeddedViewIndex;
        this.usedPipes = usedPipes;
        this.staticQueryIds = staticQueryIds;
        this.viewBuilderFactory = viewBuilderFactory;
        this.nodes = [];
        this.purePipeNodeIndices = Object.create(null);
        // Need Object.create so that we don't have builtin values...
        this.refNodeIndices = Object.create(null);
        this.variables = [];
        this.children = [];
        // TODO(tbosch): The old view compiler used to use an `any` type
        // for the context in any embedded view. We keep this behaivor for now
        // to be able to introduce the new view compiler without too many errors.
        this.compType = this.embeddedViewIndex > 0 ?
            o.DYNAMIC_TYPE :
            o.expressionType(outputCtx.importExpr(this.component.type.reference));
        this.viewName = viewClassName(this.component.type.reference, this.embeddedViewIndex);
    }
    visitAll(variables, astNodes) {
        this.variables = variables;
        // create the pipes for the pure pipes immediately, so that we know their indices.
        if (!this.parent) {
            this.usedPipes.forEach((pipe) => {
                if (pipe.pure) {
                    this.purePipeNodeIndices[pipe.name] = this._createPipe(null, pipe);
                }
            });
        }
        if (!this.parent) {
            const queryIds = staticViewQueryIds(this.staticQueryIds);
            this.component.viewQueries.forEach((query, queryIndex) => {
                // Note: queries start with id 1 so we can use the number in a Bloom filter!
                const queryId = queryIndex + 1;
                const bindingType = query.first ? 0 /* First */ : 1 /* All */;
                const flags = 134217728 /* TypeViewQuery */ | calcStaticDynamicQueryFlags(queryIds, queryId, query);
                this.nodes.push(() => ({
                    sourceSpan: null,
                    nodeFlags: flags,
                    nodeDef: o.importExpr(Identifiers.queryDef).callFn([
                        o.literal(flags), o.literal(queryId),
                        new o.LiteralMapExpr([new o.LiteralMapEntry(query.propertyName, o.literal(bindingType), false)])
                    ])
                }));
            });
        }
        templateVisitAll(this, astNodes);
        if (this.parent && (astNodes.length === 0 || needsAdditionalRootNode(astNodes))) {
            // if the view is an embedded view, then we need to add an additional root node in some cases
            this.nodes.push(() => ({
                sourceSpan: null,
                nodeFlags: 1 /* TypeElement */,
                nodeDef: o.importExpr(Identifiers.anchorDef).callFn([
                    o.literal(0 /* None */), o.NULL_EXPR, o.NULL_EXPR, o.literal(0)
                ])
            }));
        }
    }
    build(targetStatements = []) {
        this.children.forEach((child) => child.build(targetStatements));
        const { updateRendererStmts, updateDirectivesStmts, nodeDefExprs } = this._createNodeExpressions();
        const updateRendererFn = this._createUpdateFn(updateRendererStmts);
        const updateDirectivesFn = this._createUpdateFn(updateDirectivesStmts);
        let viewFlags = 0 /* None */;
        if (!this.parent && this.component.changeDetection === ChangeDetectionStrategy.OnPush) {
            viewFlags |= 2 /* OnPush */;
        }
        const viewFactory = new o.DeclareFunctionStmt(this.viewName, [new o.FnParam(LOG_VAR.name)], [new o.ReturnStatement(o.importExpr(Identifiers.viewDef).callFn([
                o.literal(viewFlags),
                o.literalArr(nodeDefExprs),
                updateDirectivesFn,
                updateRendererFn,
            ]))], o.importType(Identifiers.ViewDefinition), this.embeddedViewIndex === 0 ? [o.StmtModifier.Exported] : []);
        targetStatements.push(viewFactory);
        return targetStatements;
    }
    _createUpdateFn(updateStmts) {
        let updateFn;
        if (updateStmts.length > 0) {
            const preStmts = [];
            if (!this.component.isHost && o.findReadVarNames(updateStmts).has(COMP_VAR.name)) {
                preStmts.push(COMP_VAR.set(VIEW_VAR.prop('component')).toDeclStmt(this.compType));
            }
            updateFn = o.fn([
                new o.FnParam(CHECK_VAR.name, o.INFERRED_TYPE),
                new o.FnParam(VIEW_VAR.name, o.INFERRED_TYPE)
            ], [...preStmts, ...updateStmts], o.INFERRED_TYPE);
        }
        else {
            updateFn = o.NULL_EXPR;
        }
        return updateFn;
    }
    visitNgContent(ast, context) {
        // ngContentDef(ngContentIndex: number, index: number): NodeDef;
        this.nodes.push(() => ({
            sourceSpan: ast.sourceSpan,
            nodeFlags: 8 /* TypeNgContent */,
            nodeDef: o.importExpr(Identifiers.ngContentDef).callFn([
                o.literal(ast.ngContentIndex), o.literal(ast.index)
            ])
        }));
    }
    visitText(ast, context) {
        // Static text nodes have no check function
        const checkIndex = -1;
        this.nodes.push(() => ({
            sourceSpan: ast.sourceSpan,
            nodeFlags: 2 /* TypeText */,
            nodeDef: o.importExpr(Identifiers.textDef).callFn([
                o.literal(checkIndex),
                o.literal(ast.ngContentIndex),
                o.literalArr([o.literal(ast.value)]),
            ])
        }));
    }
    visitBoundText(ast, context) {
        const nodeIndex = this.nodes.length;
        // reserve the space in the nodeDefs array
        this.nodes.push(null);
        const astWithSource = ast.value;
        const inter = astWithSource.ast;
        const updateRendererExpressions = inter.expressions.map((expr, bindingIndex) => this._preprocessUpdateExpression({ nodeIndex, bindingIndex, sourceSpan: ast.sourceSpan, context: COMP_VAR, value: expr }));
        // Check index is the same as the node index during compilation
        // They might only differ at runtime
        const checkIndex = nodeIndex;
        this.nodes[nodeIndex] = () => ({
            sourceSpan: ast.sourceSpan,
            nodeFlags: 2 /* TypeText */,
            nodeDef: o.importExpr(Identifiers.textDef).callFn([
                o.literal(checkIndex),
                o.literal(ast.ngContentIndex),
                o.literalArr(inter.strings.map(s => o.literal(s))),
            ]),
            updateRenderer: updateRendererExpressions
        });
    }
    visitEmbeddedTemplate(ast, context) {
        const nodeIndex = this.nodes.length;
        // reserve the space in the nodeDefs array
        this.nodes.push(null);
        const { flags, queryMatchesExpr, hostEvents } = this._visitElementOrTemplate(nodeIndex, ast);
        const childVisitor = this.viewBuilderFactory(this);
        this.children.push(childVisitor);
        childVisitor.visitAll(ast.variables, ast.children);
        const childCount = this.nodes.length - nodeIndex - 1;
        // anchorDef(
        //   flags: NodeFlags, matchedQueries: [string, QueryValueType][], ngContentIndex: number,
        //   childCount: number, handleEventFn?: ElementHandleEventFn, templateFactory?:
        //   ViewDefinitionFactory): NodeDef;
        this.nodes[nodeIndex] = () => ({
            sourceSpan: ast.sourceSpan,
            nodeFlags: 1 /* TypeElement */ | flags,
            nodeDef: o.importExpr(Identifiers.anchorDef).callFn([
                o.literal(flags),
                queryMatchesExpr,
                o.literal(ast.ngContentIndex),
                o.literal(childCount),
                this._createElementHandleEventFn(nodeIndex, hostEvents),
                o.variable(childVisitor.viewName),
            ])
        });
    }
    visitElement(ast, context) {
        const nodeIndex = this.nodes.length;
        // reserve the space in the nodeDefs array so we can add children
        this.nodes.push(null);
        // Using a null element name creates an anchor.
        const elName = isNgContainer(ast.name) ? null : ast.name;
        const { flags, usedEvents, queryMatchesExpr, hostBindings: dirHostBindings, hostEvents } = this._visitElementOrTemplate(nodeIndex, ast);
        let inputDefs = [];
        let updateRendererExpressions = [];
        let outputDefs = [];
        if (elName) {
            const hostBindings = ast.inputs
                .map((inputAst) => ({
                context: COMP_VAR,
                inputAst,
                dirAst: null,
            }))
                .concat(dirHostBindings);
            if (hostBindings.length) {
                updateRendererExpressions =
                    hostBindings.map((hostBinding, bindingIndex) => this._preprocessUpdateExpression({
                        context: hostBinding.context,
                        nodeIndex,
                        bindingIndex,
                        sourceSpan: hostBinding.inputAst.sourceSpan,
                        value: hostBinding.inputAst.value
                    }));
                inputDefs = hostBindings.map(hostBinding => elementBindingDef(hostBinding.inputAst, hostBinding.dirAst));
            }
            outputDefs = usedEvents.map(([target, eventName]) => o.literalArr([o.literal(target), o.literal(eventName)]));
        }
        templateVisitAll(this, ast.children);
        const childCount = this.nodes.length - nodeIndex - 1;
        const compAst = ast.directives.find(dirAst => dirAst.directive.isComponent);
        let compRendererType = o.NULL_EXPR;
        let compView = o.NULL_EXPR;
        if (compAst) {
            compView = this.outputCtx.importExpr(compAst.directive.componentViewType);
            compRendererType = this.outputCtx.importExpr(compAst.directive.rendererType);
        }
        // Check index is the same as the node index during compilation
        // They might only differ at runtime
        const checkIndex = nodeIndex;
        this.nodes[nodeIndex] = () => ({
            sourceSpan: ast.sourceSpan,
            nodeFlags: 1 /* TypeElement */ | flags,
            nodeDef: o.importExpr(Identifiers.elementDef).callFn([
                o.literal(checkIndex),
                o.literal(flags),
                queryMatchesExpr,
                o.literal(ast.ngContentIndex),
                o.literal(childCount),
                o.literal(elName),
                elName ? fixedAttrsDef(ast) : o.NULL_EXPR,
                inputDefs.length ? o.literalArr(inputDefs) : o.NULL_EXPR,
                outputDefs.length ? o.literalArr(outputDefs) : o.NULL_EXPR,
                this._createElementHandleEventFn(nodeIndex, hostEvents),
                compView,
                compRendererType,
            ]),
            updateRenderer: updateRendererExpressions
        });
    }
    _visitElementOrTemplate(nodeIndex, ast) {
        let flags = 0 /* None */;
        if (ast.hasViewContainer) {
            flags |= 16777216 /* EmbeddedViews */;
        }
        const usedEvents = new Map();
        ast.outputs.forEach((event) => {
            const { name, target } = elementEventNameAndTarget(event, null);
            usedEvents.set(elementEventFullName(target, name), [target, name]);
        });
        ast.directives.forEach((dirAst) => {
            dirAst.hostEvents.forEach((event) => {
                const { name, target } = elementEventNameAndTarget(event, dirAst);
                usedEvents.set(elementEventFullName(target, name), [target, name]);
            });
        });
        const hostBindings = [];
        const hostEvents = [];
        this._visitComponentFactoryResolverProvider(ast.directives);
        ast.providers.forEach((providerAst, providerIndex) => {
            let dirAst = undefined;
            let dirIndex = undefined;
            ast.directives.forEach((localDirAst, i) => {
                if (localDirAst.directive.type.reference === tokenReference(providerAst.token)) {
                    dirAst = localDirAst;
                    dirIndex = i;
                }
            });
            if (dirAst) {
                const { hostBindings: dirHostBindings, hostEvents: dirHostEvents } = this._visitDirective(providerAst, dirAst, dirIndex, nodeIndex, ast.references, ast.queryMatches, usedEvents, this.staticQueryIds.get(ast));
                hostBindings.push(...dirHostBindings);
                hostEvents.push(...dirHostEvents);
            }
            else {
                this._visitProvider(providerAst, ast.queryMatches);
            }
        });
        let queryMatchExprs = [];
        ast.queryMatches.forEach((match) => {
            let valueType = undefined;
            if (tokenReference(match.value) ===
                this.reflector.resolveExternalReference(Identifiers.ElementRef)) {
                valueType = 0 /* ElementRef */;
            }
            else if (tokenReference(match.value) ===
                this.reflector.resolveExternalReference(Identifiers.ViewContainerRef)) {
                valueType = 3 /* ViewContainerRef */;
            }
            else if (tokenReference(match.value) ===
                this.reflector.resolveExternalReference(Identifiers.TemplateRef)) {
                valueType = 2 /* TemplateRef */;
            }
            if (valueType != null) {
                queryMatchExprs.push(o.literalArr([o.literal(match.queryId), o.literal(valueType)]));
            }
        });
        ast.references.forEach((ref) => {
            let valueType = undefined;
            if (!ref.value) {
                valueType = 1 /* RenderElement */;
            }
            else if (tokenReference(ref.value) ===
                this.reflector.resolveExternalReference(Identifiers.TemplateRef)) {
                valueType = 2 /* TemplateRef */;
            }
            if (valueType != null) {
                this.refNodeIndices[ref.name] = nodeIndex;
                queryMatchExprs.push(o.literalArr([o.literal(ref.name), o.literal(valueType)]));
            }
        });
        ast.outputs.forEach((outputAst) => {
            hostEvents.push({ context: COMP_VAR, eventAst: outputAst, dirAst: null });
        });
        return {
            flags,
            usedEvents: Array.from(usedEvents.values()),
            queryMatchesExpr: queryMatchExprs.length ? o.literalArr(queryMatchExprs) : o.NULL_EXPR,
            hostBindings,
            hostEvents: hostEvents
        };
    }
    _visitDirective(providerAst, dirAst, directiveIndex, elementNodeIndex, refs, queryMatches, usedEvents, queryIds) {
        const nodeIndex = this.nodes.length;
        // reserve the space in the nodeDefs array so we can add children
        this.nodes.push(null);
        dirAst.directive.queries.forEach((query, queryIndex) => {
            const queryId = dirAst.contentQueryStartId + queryIndex;
            const flags = 67108864 /* TypeContentQuery */ | calcStaticDynamicQueryFlags(queryIds, queryId, query);
            const bindingType = query.first ? 0 /* First */ : 1 /* All */;
            this.nodes.push(() => ({
                sourceSpan: dirAst.sourceSpan,
                nodeFlags: flags,
                nodeDef: o.importExpr(Identifiers.queryDef).callFn([
                    o.literal(flags), o.literal(queryId),
                    new o.LiteralMapExpr([new o.LiteralMapEntry(query.propertyName, o.literal(bindingType), false)])
                ]),
            }));
        });
        // Note: the operation below might also create new nodeDefs,
        // but we don't want them to be a child of a directive,
        // as they might be a provider/pipe on their own.
        // I.e. we only allow queries as children of directives nodes.
        const childCount = this.nodes.length - nodeIndex - 1;
        let { flags, queryMatchExprs, providerExpr, depsExpr } = this._visitProviderOrDirective(providerAst, queryMatches);
        refs.forEach((ref) => {
            if (ref.value && tokenReference(ref.value) === tokenReference(providerAst.token)) {
                this.refNodeIndices[ref.name] = nodeIndex;
                queryMatchExprs.push(o.literalArr([o.literal(ref.name), o.literal(4 /* Provider */)]));
            }
        });
        if (dirAst.directive.isComponent) {
            flags |= 32768 /* Component */;
        }
        const inputDefs = dirAst.inputs.map((inputAst, inputIndex) => {
            const mapValue = o.literalArr([o.literal(inputIndex), o.literal(inputAst.directiveName)]);
            // Note: it's important to not quote the key so that we can capture renames by minifiers!
            return new o.LiteralMapEntry(inputAst.directiveName, mapValue, false);
        });
        const outputDefs = [];
        const dirMeta = dirAst.directive;
        Object.keys(dirMeta.outputs).forEach((propName) => {
            const eventName = dirMeta.outputs[propName];
            if (usedEvents.has(eventName)) {
                // Note: it's important to not quote the key so that we can capture renames by minifiers!
                outputDefs.push(new o.LiteralMapEntry(propName, o.literal(eventName), false));
            }
        });
        let updateDirectiveExpressions = [];
        if (dirAst.inputs.length || (flags & (262144 /* DoCheck */ | 65536 /* OnInit */)) > 0) {
            updateDirectiveExpressions =
                dirAst.inputs.map((input, bindingIndex) => this._preprocessUpdateExpression({
                    nodeIndex,
                    bindingIndex,
                    sourceSpan: input.sourceSpan,
                    context: COMP_VAR,
                    value: input.value
                }));
        }
        const dirContextExpr = o.importExpr(Identifiers.nodeValue).callFn([VIEW_VAR, o.literal(nodeIndex)]);
        const hostBindings = dirAst.hostProperties.map((inputAst) => ({
            context: dirContextExpr,
            dirAst,
            inputAst,
        }));
        const hostEvents = dirAst.hostEvents.map((hostEventAst) => ({
            context: dirContextExpr,
            eventAst: hostEventAst, dirAst,
        }));
        // Check index is the same as the node index during compilation
        // They might only differ at runtime
        const checkIndex = nodeIndex;
        this.nodes[nodeIndex] = () => ({
            sourceSpan: dirAst.sourceSpan,
            nodeFlags: 16384 /* TypeDirective */ | flags,
            nodeDef: o.importExpr(Identifiers.directiveDef).callFn([
                o.literal(checkIndex),
                o.literal(flags),
                queryMatchExprs.length ? o.literalArr(queryMatchExprs) : o.NULL_EXPR,
                o.literal(childCount),
                providerExpr,
                depsExpr,
                inputDefs.length ? new o.LiteralMapExpr(inputDefs) : o.NULL_EXPR,
                outputDefs.length ? new o.LiteralMapExpr(outputDefs) : o.NULL_EXPR,
            ]),
            updateDirectives: updateDirectiveExpressions,
            directive: dirAst.directive.type,
        });
        return { hostBindings, hostEvents };
    }
    _visitProvider(providerAst, queryMatches) {
        this._addProviderNode(this._visitProviderOrDirective(providerAst, queryMatches));
    }
    _visitComponentFactoryResolverProvider(directives) {
        const componentDirMeta = directives.find(dirAst => dirAst.directive.isComponent);
        if (componentDirMeta && componentDirMeta.directive.entryComponents.length) {
            const { providerExpr, depsExpr, flags, tokenExpr } = componentFactoryResolverProviderDef(this.reflector, this.outputCtx, 8192 /* PrivateProvider */, componentDirMeta.directive.entryComponents);
            this._addProviderNode({
                providerExpr,
                depsExpr,
                flags,
                tokenExpr,
                queryMatchExprs: [],
                sourceSpan: componentDirMeta.sourceSpan
            });
        }
    }
    _addProviderNode(data) {
        const nodeIndex = this.nodes.length;
        // providerDef(
        //   flags: NodeFlags, matchedQueries: [string, QueryValueType][], token:any,
        //   value: any, deps: ([DepFlags, any] | any)[]): NodeDef;
        this.nodes.push(() => ({
            sourceSpan: data.sourceSpan,
            nodeFlags: data.flags,
            nodeDef: o.importExpr(Identifiers.providerDef).callFn([
                o.literal(data.flags),
                data.queryMatchExprs.length ? o.literalArr(data.queryMatchExprs) : o.NULL_EXPR,
                data.tokenExpr, data.providerExpr, data.depsExpr
            ])
        }));
    }
    _visitProviderOrDirective(providerAst, queryMatches) {
        let flags = 0 /* None */;
        let queryMatchExprs = [];
        queryMatches.forEach((match) => {
            if (tokenReference(match.value) === tokenReference(providerAst.token)) {
                queryMatchExprs.push(o.literalArr([o.literal(match.queryId), o.literal(4 /* Provider */)]));
            }
        });
        const { providerExpr, depsExpr, flags: providerFlags, tokenExpr } = providerDef(this.outputCtx, providerAst);
        return {
            flags: flags | providerFlags,
            queryMatchExprs,
            providerExpr,
            depsExpr,
            tokenExpr,
            sourceSpan: providerAst.sourceSpan
        };
    }
    getLocal(name) {
        if (name == EventHandlerVars.event.name) {
            return EventHandlerVars.event;
        }
        let currViewExpr = VIEW_VAR;
        for (let currBuilder = this; currBuilder; currBuilder = currBuilder.parent,
            currViewExpr = currViewExpr.prop('parent').cast(o.DYNAMIC_TYPE)) {
            // check references
            const refNodeIndex = currBuilder.refNodeIndices[name];
            if (refNodeIndex != null) {
                return o.importExpr(Identifiers.nodeValue).callFn([currViewExpr, o.literal(refNodeIndex)]);
            }
            // check variables
            const varAst = currBuilder.variables.find((varAst) => varAst.name === name);
            if (varAst) {
                const varValue = varAst.value || IMPLICIT_TEMPLATE_VAR;
                return currViewExpr.prop('context').prop(varValue);
            }
        }
        return null;
    }
    _createLiteralArrayConverter(sourceSpan, argCount) {
        if (argCount === 0) {
            const valueExpr = o.importExpr(Identifiers.EMPTY_ARRAY);
            return () => valueExpr;
        }
        const checkIndex = this.nodes.length;
        this.nodes.push(() => ({
            sourceSpan,
            nodeFlags: 32 /* TypePureArray */,
            nodeDef: o.importExpr(Identifiers.pureArrayDef).callFn([
                o.literal(checkIndex),
                o.literal(argCount),
            ])
        }));
        return (args) => callCheckStmt(checkIndex, args);
    }
    _createLiteralMapConverter(sourceSpan, keys) {
        if (keys.length === 0) {
            const valueExpr = o.importExpr(Identifiers.EMPTY_MAP);
            return () => valueExpr;
        }
        const map = o.literalMap(keys.map((e, i) => (Object.assign({}, e, { value: o.literal(i) }))));
        const checkIndex = this.nodes.length;
        this.nodes.push(() => ({
            sourceSpan,
            nodeFlags: 64 /* TypePureObject */,
            nodeDef: o.importExpr(Identifiers.pureObjectDef).callFn([
                o.literal(checkIndex),
                map,
            ])
        }));
        return (args) => callCheckStmt(checkIndex, args);
    }
    _createPipeConverter(expression, name, argCount) {
        const pipe = this.usedPipes.find((pipeSummary) => pipeSummary.name === name);
        if (pipe.pure) {
            const checkIndex = this.nodes.length;
            this.nodes.push(() => ({
                sourceSpan: expression.sourceSpan,
                nodeFlags: 128 /* TypePurePipe */,
                nodeDef: o.importExpr(Identifiers.purePipeDef).callFn([
                    o.literal(checkIndex),
                    o.literal(argCount),
                ])
            }));
            // find underlying pipe in the component view
            let compViewExpr = VIEW_VAR;
            let compBuilder = this;
            while (compBuilder.parent) {
                compBuilder = compBuilder.parent;
                compViewExpr = compViewExpr.prop('parent').cast(o.DYNAMIC_TYPE);
            }
            const pipeNodeIndex = compBuilder.purePipeNodeIndices[name];
            const pipeValueExpr = o.importExpr(Identifiers.nodeValue).callFn([compViewExpr, o.literal(pipeNodeIndex)]);
            return (args) => callUnwrapValue(expression.nodeIndex, expression.bindingIndex, callCheckStmt(checkIndex, [pipeValueExpr].concat(args)));
        }
        else {
            const nodeIndex = this._createPipe(expression.sourceSpan, pipe);
            const nodeValueExpr = o.importExpr(Identifiers.nodeValue).callFn([VIEW_VAR, o.literal(nodeIndex)]);
            return (args) => callUnwrapValue(expression.nodeIndex, expression.bindingIndex, nodeValueExpr.callMethod('transform', args));
        }
    }
    _createPipe(sourceSpan, pipe) {
        const nodeIndex = this.nodes.length;
        let flags = 0 /* None */;
        pipe.type.lifecycleHooks.forEach((lifecycleHook) => {
            // for pipes, we only support ngOnDestroy
            if (lifecycleHook === LifecycleHooks.OnDestroy) {
                flags |= lifecycleHookToNodeFlag(lifecycleHook);
            }
        });
        const depExprs = pipe.type.diDeps.map((diDep) => depDef(this.outputCtx, diDep));
        // function pipeDef(
        //   flags: NodeFlags, ctor: any, deps: ([DepFlags, any] | any)[]): NodeDef
        this.nodes.push(() => ({
            sourceSpan,
            nodeFlags: 16 /* TypePipe */,
            nodeDef: o.importExpr(Identifiers.pipeDef).callFn([
                o.literal(flags), this.outputCtx.importExpr(pipe.type.reference), o.literalArr(depExprs)
            ])
        }));
        return nodeIndex;
    }
    /**
     * For the AST in `UpdateExpression.value`:
     * - create nodes for pipes, literal arrays and, literal maps,
     * - update the AST to replace pipes, literal arrays and, literal maps with calls to check fn.
     *
     * WARNING: This might create new nodeDefs (for pipes and literal arrays and literal maps)!
     */
    _preprocessUpdateExpression(expression) {
        return {
            nodeIndex: expression.nodeIndex,
            bindingIndex: expression.bindingIndex,
            sourceSpan: expression.sourceSpan,
            context: expression.context,
            value: convertPropertyBindingBuiltins({
                createLiteralArrayConverter: (argCount) => this._createLiteralArrayConverter(expression.sourceSpan, argCount),
                createLiteralMapConverter: (keys) => this._createLiteralMapConverter(expression.sourceSpan, keys),
                createPipeConverter: (name, argCount) => this._createPipeConverter(expression, name, argCount)
            }, expression.value)
        };
    }
    _createNodeExpressions() {
        const self = this;
        let updateBindingCount = 0;
        const updateRendererStmts = [];
        const updateDirectivesStmts = [];
        const nodeDefExprs = this.nodes.map((factory, nodeIndex) => {
            const { nodeDef, nodeFlags, updateDirectives, updateRenderer, sourceSpan } = factory();
            if (updateRenderer) {
                updateRendererStmts.push(...createUpdateStatements(nodeIndex, sourceSpan, updateRenderer, false));
            }
            if (updateDirectives) {
                updateDirectivesStmts.push(...createUpdateStatements(nodeIndex, sourceSpan, updateDirectives, (nodeFlags & (262144 /* DoCheck */ | 65536 /* OnInit */)) > 0));
            }
            // We use a comma expression to call the log function before
            // the nodeDef function, but still use the result of the nodeDef function
            // as the value.
            // Note: We only add the logger to elements / text nodes,
            // so we don't generate too much code.
            const logWithNodeDef = nodeFlags & 3 /* CatRenderNode */ ?
                new o.CommaExpr([LOG_VAR.callFn([]).callFn([]), nodeDef]) :
                nodeDef;
            return o.applySourceSpanToExpressionIfNeeded(logWithNodeDef, sourceSpan);
        });
        return { updateRendererStmts, updateDirectivesStmts, nodeDefExprs };
        function createUpdateStatements(nodeIndex, sourceSpan, expressions, allowEmptyExprs) {
            const updateStmts = [];
            const exprs = expressions.map(({ sourceSpan, context, value }) => {
                const bindingId = `${updateBindingCount++}`;
                const nameResolver = context === COMP_VAR ? self : null;
                const { stmts, currValExpr } = convertPropertyBinding(nameResolver, context, value, bindingId, BindingForm.General);
                updateStmts.push(...stmts.map((stmt) => o.applySourceSpanToStatementIfNeeded(stmt, sourceSpan)));
                return o.applySourceSpanToExpressionIfNeeded(currValExpr, sourceSpan);
            });
            if (expressions.length || allowEmptyExprs) {
                updateStmts.push(o.applySourceSpanToStatementIfNeeded(callCheckStmt(nodeIndex, exprs).toStmt(), sourceSpan));
            }
            return updateStmts;
        }
    }
    _createElementHandleEventFn(nodeIndex, handlers) {
        const handleEventStmts = [];
        let handleEventBindingCount = 0;
        handlers.forEach(({ context, eventAst, dirAst }) => {
            const bindingId = `${handleEventBindingCount++}`;
            const nameResolver = context === COMP_VAR ? this : null;
            const { stmts, allowDefault } = convertActionBinding(nameResolver, context, eventAst.handler, bindingId);
            const trueStmts = stmts;
            if (allowDefault) {
                trueStmts.push(ALLOW_DEFAULT_VAR.set(allowDefault.and(ALLOW_DEFAULT_VAR)).toStmt());
            }
            const { target: eventTarget, name: eventName } = elementEventNameAndTarget(eventAst, dirAst);
            const fullEventName = elementEventFullName(eventTarget, eventName);
            handleEventStmts.push(o.applySourceSpanToStatementIfNeeded(new o.IfStmt(o.literal(fullEventName).identical(EVENT_NAME_VAR), trueStmts), eventAst.sourceSpan));
        });
        let handleEventFn;
        if (handleEventStmts.length > 0) {
            const preStmts = [ALLOW_DEFAULT_VAR.set(o.literal(true)).toDeclStmt(o.BOOL_TYPE)];
            if (!this.component.isHost && o.findReadVarNames(handleEventStmts).has(COMP_VAR.name)) {
                preStmts.push(COMP_VAR.set(VIEW_VAR.prop('component')).toDeclStmt(this.compType));
            }
            handleEventFn = o.fn([
                new o.FnParam(VIEW_VAR.name, o.INFERRED_TYPE),
                new o.FnParam(EVENT_NAME_VAR.name, o.INFERRED_TYPE),
                new o.FnParam(EventHandlerVars.event.name, o.INFERRED_TYPE)
            ], [...preStmts, ...handleEventStmts, new o.ReturnStatement(ALLOW_DEFAULT_VAR)], o.INFERRED_TYPE);
        }
        else {
            handleEventFn = o.NULL_EXPR;
        }
        return handleEventFn;
    }
    visitDirective(ast, context) { }
    visitDirectiveProperty(ast, context) { }
    visitReference(ast, context) { }
    visitVariable(ast, context) { }
    visitEvent(ast, context) { }
    visitElementProperty(ast, context) { }
    visitAttr(ast, context) { }
}
function needsAdditionalRootNode(astNodes) {
    const lastAstNode = astNodes[astNodes.length - 1];
    if (lastAstNode instanceof EmbeddedTemplateAst) {
        return lastAstNode.hasViewContainer;
    }
    if (lastAstNode instanceof ElementAst) {
        if (isNgContainer(lastAstNode.name) && lastAstNode.children.length) {
            return needsAdditionalRootNode(lastAstNode.children);
        }
        return lastAstNode.hasViewContainer;
    }
    return lastAstNode instanceof NgContentAst;
}
function elementBindingDef(inputAst, dirAst) {
    const inputType = inputAst.type;
    switch (inputType) {
        case 1 /* Attribute */:
            return o.literalArr([
                o.literal(1 /* TypeElementAttribute */), o.literal(inputAst.name),
                o.literal(inputAst.securityContext)
            ]);
        case 0 /* Property */:
            return o.literalArr([
                o.literal(8 /* TypeProperty */), o.literal(inputAst.name),
                o.literal(inputAst.securityContext)
            ]);
        case 4 /* Animation */:
            const bindingType = 8 /* TypeProperty */ |
                (dirAst && dirAst.directive.isComponent ? 32 /* SyntheticHostProperty */ :
                    16 /* SyntheticProperty */);
            return o.literalArr([
                o.literal(bindingType), o.literal('@' + inputAst.name), o.literal(inputAst.securityContext)
            ]);
        case 2 /* Class */:
            return o.literalArr([o.literal(2 /* TypeElementClass */), o.literal(inputAst.name), o.NULL_EXPR]);
        case 3 /* Style */:
            return o.literalArr([
                o.literal(4 /* TypeElementStyle */), o.literal(inputAst.name), o.literal(inputAst.unit)
            ]);
        default:
            // This default case is not needed by TypeScript compiler, as the switch is exhaustive.
            // However Closure Compiler does not understand that and reports an error in typed mode.
            // The `throw new Error` below works around the problem, and the unexpected: never variable
            // makes sure tsc still checks this code is unreachable.
            const unexpected = inputType;
            throw new Error(`unexpected ${unexpected}`);
    }
}
function fixedAttrsDef(elementAst) {
    const mapResult = Object.create(null);
    elementAst.attrs.forEach(attrAst => { mapResult[attrAst.name] = attrAst.value; });
    elementAst.directives.forEach(dirAst => {
        Object.keys(dirAst.directive.hostAttributes).forEach(name => {
            const value = dirAst.directive.hostAttributes[name];
            const prevValue = mapResult[name];
            mapResult[name] = prevValue != null ? mergeAttributeValue(name, prevValue, value) : value;
        });
    });
    // Note: We need to sort to get a defined output order
    // for tests and for caching generated artifacts...
    return o.literalArr(Object.keys(mapResult).sort().map((attrName) => o.literalArr([o.literal(attrName), o.literal(mapResult[attrName])])));
}
function mergeAttributeValue(attrName, attrValue1, attrValue2) {
    if (attrName == CLASS_ATTR || attrName == STYLE_ATTR) {
        return `${attrValue1} ${attrValue2}`;
    }
    else {
        return attrValue2;
    }
}
function callCheckStmt(nodeIndex, exprs) {
    if (exprs.length > 10) {
        return CHECK_VAR.callFn([VIEW_VAR, o.literal(nodeIndex), o.literal(1 /* Dynamic */), o.literalArr(exprs)]);
    }
    else {
        return CHECK_VAR.callFn([VIEW_VAR, o.literal(nodeIndex), o.literal(0 /* Inline */), ...exprs]);
    }
}
function callUnwrapValue(nodeIndex, bindingIdx, expr) {
    return o.importExpr(Identifiers.unwrapValue).callFn([
        VIEW_VAR, o.literal(nodeIndex), o.literal(bindingIdx), expr
    ]);
}
function findStaticQueryIds(nodes, result = new Map()) {
    nodes.forEach((node) => {
        const staticQueryIds = new Set();
        const dynamicQueryIds = new Set();
        let queryMatches = undefined;
        if (node instanceof ElementAst) {
            findStaticQueryIds(node.children, result);
            node.children.forEach((child) => {
                const childData = result.get(child);
                childData.staticQueryIds.forEach(queryId => staticQueryIds.add(queryId));
                childData.dynamicQueryIds.forEach(queryId => dynamicQueryIds.add(queryId));
            });
            queryMatches = node.queryMatches;
        }
        else if (node instanceof EmbeddedTemplateAst) {
            findStaticQueryIds(node.children, result);
            node.children.forEach((child) => {
                const childData = result.get(child);
                childData.staticQueryIds.forEach(queryId => dynamicQueryIds.add(queryId));
                childData.dynamicQueryIds.forEach(queryId => dynamicQueryIds.add(queryId));
            });
            queryMatches = node.queryMatches;
        }
        if (queryMatches) {
            queryMatches.forEach((match) => staticQueryIds.add(match.queryId));
        }
        dynamicQueryIds.forEach(queryId => staticQueryIds.delete(queryId));
        result.set(node, { staticQueryIds, dynamicQueryIds });
    });
    return result;
}
function staticViewQueryIds(nodeStaticQueryIds) {
    const staticQueryIds = new Set();
    const dynamicQueryIds = new Set();
    Array.from(nodeStaticQueryIds.values()).forEach((entry) => {
        entry.staticQueryIds.forEach(queryId => staticQueryIds.add(queryId));
        entry.dynamicQueryIds.forEach(queryId => dynamicQueryIds.add(queryId));
    });
    dynamicQueryIds.forEach(queryId => staticQueryIds.delete(queryId));
    return { staticQueryIds, dynamicQueryIds };
}
function elementEventNameAndTarget(eventAst, dirAst) {
    if (eventAst.isAnimation) {
        return {
            name: `@${eventAst.name}.${eventAst.phase}`,
            target: dirAst && dirAst.directive.isComponent ? 'component' : null
        };
    }
    else {
        return eventAst;
    }
}
function calcStaticDynamicQueryFlags(queryIds, queryId, query) {
    let flags = 0 /* None */;
    // Note: We only make queries static that query for a single item.
    // This is because of backwards compatibility with the old view compiler...
    if (query.first && shouldResolveAsStaticQuery(queryIds, queryId, query)) {
        flags |= 268435456 /* StaticQuery */;
    }
    else {
        flags |= 536870912 /* DynamicQuery */;
    }
    return flags;
}
function shouldResolveAsStaticQuery(queryIds, queryId, query) {
    // If query.static has been set by the user, use that value to determine whether
    // the query is static. If none has been set, sort the query into static/dynamic
    // based on query results (i.e. dynamic if CD needs to run to get all results).
    return query.static ||
        query.static == null &&
            (queryIds.staticQueryIds.has(queryId) || !queryIds.dynamicQueryIds.has(queryId));
}
export function elementEventFullName(target, name) {
    return target ? `${target}:${name}` : name;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmlld19jb21waWxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbXBpbGVyL3NyYy92aWV3X2NvbXBpbGVyL3ZpZXdfY29tcGlsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7OztHQU1HO0FBRUgsT0FBTyxFQUFxRSxnQkFBZ0IsRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFDLE1BQU0scUJBQXFCLENBQUM7QUFFeEosT0FBTyxFQUFDLFdBQVcsRUFBb0IsZ0JBQWdCLEVBQWlCLG9CQUFvQixFQUFFLHNCQUFzQixFQUFFLDhCQUE4QixFQUFDLE1BQU0sdUNBQXVDLENBQUM7QUFDbk0sT0FBTyxFQUE2Qix1QkFBdUIsRUFBeUQsTUFBTSxTQUFTLENBQUM7QUFFcEksT0FBTyxFQUFDLFdBQVcsRUFBQyxNQUFNLGdCQUFnQixDQUFDO0FBQzNDLE9BQU8sRUFBQyxjQUFjLEVBQUMsTUFBTSx3QkFBd0IsQ0FBQztBQUN0RCxPQUFPLEVBQUMsYUFBYSxFQUFDLE1BQU0sbUJBQW1CLENBQUM7QUFDaEQsT0FBTyxLQUFLLENBQUMsTUFBTSxzQkFBc0IsQ0FBQztBQUMxQyxPQUFPLEVBQUMsdUJBQXVCLEVBQUMsTUFBTSxzQkFBc0IsQ0FBQztBQUU3RCxPQUFPLEVBQXlHLFVBQVUsRUFBRSxtQkFBbUIsRUFBRSxZQUFZLEVBQXFILGdCQUFnQixFQUFDLE1BQU0saUNBQWlDLENBQUM7QUFHM1UsT0FBTyxFQUFDLG1DQUFtQyxFQUFFLE1BQU0sRUFBRSx1QkFBdUIsRUFBRSxXQUFXLEVBQUMsTUFBTSxxQkFBcUIsQ0FBQztBQUV0SCxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUM7QUFDM0IsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDO0FBQzNCLE1BQU0scUJBQXFCLEdBQUcsWUFBWSxDQUFDO0FBRTNDLE1BQU0sT0FBTyxpQkFBaUI7SUFDNUIsWUFBbUIsWUFBb0IsRUFBUyxlQUF1QjtR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Q2hGLCtFQUErRTtJQUMvRSxPQUFPLEtBQUssQ0FBQyxNQUFNO1FBQ2YsS0FBSyxDQUFDLE1BQU0sSUFBSSxJQUFJO1lBQ3BCLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQ3ZGLENBQUM7QUFFRCxNQUFNLFVBQVUsb0JBQW9CLENBQUMsTUFBcUIsRUFBRSxJQUFZO0lBQ3RFLE9BQU8sTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLE1BQU0sSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzdDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbiAqXG4gKiBVc2Ugb2YgdGhpcyBzb3VyY2UgY29kZSBpcyBnb3Zlcm5lZCBieSBhbiBNSVQtc3R5bGUgbGljZW5zZSB0aGF0IGNhbiBiZVxuICogZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZSBhdCBodHRwczovL2FuZ3VsYXIuaW8vbGljZW5zZVxuICovXG5cbmltcG9ydCB7Q29tcGlsZURpcmVjdGl2ZU1ldGFkYXRhLCBDb21waWxlUGlwZVN1bW1hcnksIENvbXBpbGVRdWVyeU1ldGFkYXRhLCByZW5kZXJlclR5cGVOYW1lLCB0b2tlblJlZmVyZW5jZSwgdmlld0NsYXNzTmFtZX0gZnJvbSAnLi4vY29tcGlsZV9tZXRhZGF0YSc7XG5pbXBvcnQge0NvbXBpbGVSZWZsZWN0b3J9IGZyb20gJy4uL2NvbXBpbGVfcmVmbGVjdG9yJztcbmltcG9ydCB7QmluZGluZ0Zvcm0sIEJ1aWx0aW5Db252ZXJ0ZXIsIEV2ZW50SGFuZGxlclZhcnMsIExvY2FsUmVzb2x2ZXIsIGNvbnZlcnRBY3Rpb25CaW5kaW5nLCBjb252ZXJ0UHJvcGVydHlCaW5kaW5nLCBjb252ZXJ0UHJvcGVydHlCaW5kaW5nQnVpbHRpbnN9IGZyb20gJy4uL2NvbXBpbGVyX3V0aWwvZXhwcmVzc2lvbl9jb252ZXJ0ZXInO1xuaW1wb3J0IHtBcmd1bWVudFR5cGUsIEJpbmRpbmdGbGFncywgQ2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3ksIE5vZGVGbGFncywgUXVlcnlCaW5kaW5nVHlwZSwgUXVlcnlWYWx1ZVR5cGUsIFZpZXdGbGFnc30gZnJvbSAnLi4vY29yZSc7XG5pbXBvcnQge0FTVCwgQVNUV2l0aFNvdXJjZSwgSW50ZXJwb2xhdGlvbn0gZnJvbSAnLi4vZXhwcmVzc2lvbl9wYXJzZXIvYXN0JztcbmltcG9ydCB7SWRlbnRpZmllcnN9IGZyb20gJy4uL2lkZW50aWZpZXJzJztcbmltcG9ydCB7TGlmZWN5Y2xlSG9va3N9IGZyb20gJy4uL2xpZmVjeWNsZV9yZWZsZWN0b3InO1xuaW1wb3J0IHtpc05nQ29udGFpbmVyfSBmcm9tICcuLi9tbF9wYXJzZXIvdGFncyc7XG5pbXBvcnQgKiBhcyBvIGZyb20gJy4uL291dHB1dC9vdXRwdXRfYXN0JztcbmltcG9ydCB7Y29udmVydFZhbHVlVG9PdXRwdXRBc3R9IGZyb20gJy4uL291dHB1dC92YWx1ZV91dGlsJztcbmltcG9ydCB7UGFyc2VTb3VyY2VTcGFufSBmcm9tICcuLi9wYXJzZV91dGlsJztcbmltcG9ydCB7QXR0ckFzdCwgQm91bmREaXJlY3RpdmVQcm9wZXJ0eUFzdCwgQm91bmRFbGVtZW50UHJvcGVydHlBc3QsIEJvdW5kRXZlbnRBc3QsIEJvdW5kVGV4dEFzdCwgRGlyZWN0aXZlQXN0LCBFbGVtZW50QXN0LCBFbWJlZGRlZFRlbXBsYXRlQXN0LCBOZ0NvbnRlbnRBc3QsIFByb3BlcnR5QmluZGluZ1R5cGUsIFByb3ZpZGVyQXN0LCBRdWVyeU1hdGNoLCBSZWZlcmVuY2VBc3QsIFRlbXBsYXRlQXN0LCBUZW1wbGF0ZUFzdFZpc2l0b3IsIFRleHRBc3QsIFZhcmlhYmxlQXN0LCB0ZW1wbGF0ZVZpc2l0QWxsfSBmcm9tICcuLi90ZW1wbGF0ZV9wYXJzZXIvdGVtcGxhdGVfYXN0JztcbmltcG9ydCB7T3V0cHV0Q29udGV4dH0gZnJvbSAnLi4vdXRpbCc7XG5cbmltcG9ydCB7Y29tcG9uZW50RmFjdG9yeVJlc29sdmVyUHJvdmlkZXJEZWYsIGRlcERlZiwgbGlmZWN5Y2xlSG9va1RvTm9kZUZsYWcsIHByb3ZpZGVyRGVmfSBmcm9tICcuL3Byb3ZpZGVyX2NvbXBpbGVyJztcblxuY29uc3QgQ0xBU1NfQVRUUiA9ICdjbGFzcyc7XG5jb25zdCBTVFlMRV9BVFRSID0gJ3N0eWxlJztcbmNvbnN0IElNUExJQ0lUX1RFTVBMQVRFX1ZBUiA9ICdcXCRpbXBsaWNpdCc7XG5cbmV4cG9ydCBjbGFzcyBWaWV3Q29tcGlsZVJlc3VsdCB7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyB2aWV3Q2xhc3NWYXI6IHN0cmluZywgcHVibGljIHJlbmRlcmVyVHlwZVZhcjogc3RyaW5nKSB7fVxufVxuXG5leHBvcnQgY2xhc3MgVmlld0NvbXBpbGVyIHtcbiAgY29uc3RydWN0b3IocHJpdmF0ZSBfcmVmbGVjdG9yOiBDb21waWxlUmVmbGVjdG9yKSB7fVxuXG4gIGNvbXBpbGVDb21wb25lbnQoXG4gICAgICBvdXRwdXRDdHg6IE91dHB1dENvbnRleHQsIGNvbXBvbmVudDogQ29tcGlsZURpcmVjdGl2ZU1ldGFkYXRhLCB0ZW1wbGF0ZTogVGVtcGxhdGVBc3RbXSxcbiAgICAgIHN0eWxlczogby5FeHByZXNzaW9uLCB1c2VkUGlwZXM6IENvbXBpbGVQaXBlU3VtbWFyeVtdKTogVmlld0NvbXBpbGVSZXN1bHQge1xuICAgIGxldCBlbWJlZGRlZFZpZXdDb3VudCA9IDA7XG4gICAgY29uc3Qgc3RhdGljUXVlcnlJZHMgPSBmaW5kU3RhdGljUXVlcnlJZHModGVtcGxhdGUpO1xuXG4gICAgbGV0IHJlbmRlckNvbXBvbmVudFZhck5hbWU6IHN0cmluZyA9IHVuZGVmaW5lZCAhO1xuICAgIGlmICghY29tcG9uZW50LmlzSG9zdCkge1xuICAgICAgY29uc3QgdGVtcGxhdGUgPSBjb21wb25lbnQudGVtcGxhdGUgITtcbiAgICAgIGNvbnN0IGN1c3RvbVJlbmRlckRhdGE6IG8uTGl0ZXJhbE1hcEVudHJ5W10gPSBbXTtcbiAgICAgIGlmICh0ZW1wbGF0ZS5hbmltYXRpb25zICYmIHRlbXBsYXRlLmFuaW1hdGlvbnMubGVuZ3RoKSB7XG4gICAgICAgIGN1c3RvbVJlbmRlckRhdGEucHVzaChuZXcgby5MaXRlcmFsTWFwRW50cnkoXG4gICAgICAgICAgICAnYW5pbWF0aW9uJywgY29udmVydFZhbHVlVG9PdXRwdXRBc3Qob3V0cHV0Q3R4LCB0ZW1wbGF0ZS5hbmltYXRpb25zKSwgdHJ1ZSkpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZW5kZXJDb21wb25lbnRWYXIgPSBvLnZhcmlhYmxlKHJlbmRlcmVyVHlwZU5hbWUoY29tcG9uZW50LnR5cGUucmVmZXJlbmNlKSk7XG4gICAgICByZW5kZXJDb21wb25lbnRWYXJOYW1lID0gcmVuZGVyQ29tcG9uZW50VmFyLm5hbWUgITtcbiAgICAgIG91dHB1dEN0eC5zdGF0ZW1lbnRzLnB1c2goXG4gICAgICAgICAgcmVuZGVyQ29tcG9uZW50VmFyXG4gICAgICAgICAgICAgIC5zZXQoby5pbXBvcnRFeHByKElkZW50aWZpZXJzLmNyZWF0ZVJlbmRlcmVyVHlwZTIpLmNhbGxGbihbbmV3IG8uTGl0ZXJhbE1hcEV4cHIoW1xuICAgICAgICAgICAgICAgIG5ldyBvLkxpdGVyYWxNYXBFbnRyeSgnZW5jYXBzdWxhdGlvbicsIG8ubGl0ZXJhbCh0ZW1wbGF0ZS5lbmNhcHN1bGF0aW9uKSwgZmFsc2UpLFxuICAgICAgICAgICAgICAgIG5ldyBvLkxpdGVyYWxNYXBFbnRyeSgnc3R5bGVzJywgc3R5bGVzLCBmYWxzZSksXG4gICAgICAgICAgICAgICAgbmV3IG8uTGl0ZXJhbE1hcEVudHJ5KCdkYXRhJywgbmV3IG8uTGl0ZXJhbE1hcEV4cHIoY3VzdG9tUmVuZGVyRGF0YSksIGZhbHNlKVxuICAgICAgICAgICAgICBdKV0pKVxuICAgICAgICAgICAgICAudG9EZWNsU3RtdChcbiAgICAgICAgICAgICAgICAgIG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5SZW5kZXJlclR5cGUyKSxcbiAgICAgICAgICAgICAgICAgIFtvLlN0bXRNb2RpZmllci5GaW5hbCwgby5TdG10TW9kaWZpZXIuRXhwb3J0ZWRdKSk7XG4gICAgfVxuXG4gICAgY29uc3Qgdmlld0J1aWxkZXJGYWN0b3J5ID0gKHBhcmVudDogVmlld0J1aWxkZXIgfCBudWxsKTogVmlld0J1aWxkZXIgPT4ge1xuICAgICAgY29uc3QgZW1iZWRkZWRWaWV3SW5kZXggPSBlbWJlZGRlZFZpZXdDb3VudCsrO1xuICAgICAgcmV0dXJuIG5ldyBWaWV3QnVpbGRlcihcbiAgICAgICAgICB0aGlzLl9yZWZsZWN0b3IsIG91dHB1dEN0eCwgcGFyZW50LCBjb21wb25lbnQsIGVtYmVkZGVkVmlld0luZGV4LCB1c2VkUGlwZXMsXG4gICAgICAgICAgc3RhdGljUXVlcnlJZHMsIHZpZXdCdWlsZGVyRmFjdG9yeSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHZpc2l0b3IgPSB2aWV3QnVpbGRlckZhY3RvcnkobnVsbCk7XG4gICAgdmlzaXRvci52aXNpdEFsbChbXSwgdGVtcGxhdGUpO1xuXG4gICAgb3V0cHV0Q3R4LnN0YXRlbWVudHMucHVzaCguLi52aXNpdG9yLmJ1aWxkKCkpO1xuXG4gICAgcmV0dXJuIG5ldyBWaWV3Q29tcGlsZVJlc3VsdCh2aXNpdG9yLnZpZXdOYW1lLCByZW5kZXJDb21wb25lbnRWYXJOYW1lKTtcbiAgfVxufVxuXG5pbnRlcmZhY2UgVmlld0J1aWxkZXJGYWN0b3J5IHtcbiAgKHBhcmVudDogVmlld0J1aWxkZXIpOiBWaWV3QnVpbGRlcjtcbn1cblxuaW50ZXJmYWNlIFVwZGF0ZUV4cHJlc3Npb24ge1xuICBjb250ZXh0OiBvLkV4cHJlc3Npb247XG4gIG5vZGVJbmRleDogbnVtYmVyO1xuICBiaW5kaW5nSW5kZXg6IG51bWJlcjtcbiAgc291cmNlU3BhbjogUGFyc2VTb3VyY2VTcGFuO1xuICB2YWx1ZTogQVNUO1xufVxuXG5jb25zdCBMT0dfVkFSID0gby52YXJpYWJsZSgnX2wnKTtcbmNvbnN0IFZJRVdfVkFSID0gby52YXJpYWJsZSgnX3YnKTtcbmNvbnN0IENIRUNLX1ZBUiA9IG8udmFyaWFibGUoJ19jaycpO1xuY29uc3QgQ09NUF9WQVIgPSBvLnZhcmlhYmxlKCdfY28nKTtcbmNvbnN0IEVWRU5UX05BTUVfVkFSID0gby52YXJpYWJsZSgnZW4nKTtcbmNvbnN0IEFMTE9XX0RFRkFVTFRfVkFSID0gby52YXJpYWJsZShgYWRgKTtcblxuY2xhc3MgVmlld0J1aWxkZXIgaW1wbGVtZW50cyBUZW1wbGF0ZUFzdFZpc2l0b3IsIExvY2FsUmVzb2x2ZXIge1xuICBwcml2YXRlIGNvbXBUeXBlOiBvLlR5cGU7XG4gIHByaXZhdGUgbm9kZXM6ICgoKSA9PiB7XG4gICAgc291cmNlU3BhbjogUGFyc2VTb3VyY2VTcGFuIHwgbnVsbCxcbiAgICBub2RlRGVmOiBvLkV4cHJlc3Npb24sXG4gICAgbm9kZUZsYWdzOiBOb2RlRmxhZ3MsIHVwZGF0ZURpcmVjdGl2ZXM/OiBVcGRhdGVFeHByZXNzaW9uW10sIHVwZGF0ZVJlbmRlcmVyPzogVXBkYXRlRXhwcmVzc2lvbltdXG4gIH0pW10gPSBbXTtcbiAgcHJpdmF0ZSBwdXJlUGlwZU5vZGVJbmRpY2VzOiB7W3BpcGVOYW1lOiBzdHJpbmddOiBudW1iZXJ9ID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgLy8gTmVlZCBPYmplY3QuY3JlYXRlIHNvIHRoYXQgd2UgZG9uJ3QgaGF2ZSBidWlsdGluIHZhbHVlcy4uLlxuICBwcml2YXRlIHJlZk5vZGVJbmRpY2VzOiB7W3JlZk5hbWU6IHN0cmluZ106IG51bWJlcn0gPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICBwcml2YXRlIHZhcmlhYmxlczogVmFyaWFibGVBc3RbXSA9IFtdO1xuICBwcml2YXRlIGNoaWxkcmVuOiBWaWV3QnVpbGRlcltdID0gW107XG5cbiAgcHVibGljIHJlYWRvbmx5IHZpZXdOYW1lOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIHJlZmxlY3RvcjogQ29tcGlsZVJlZmxlY3RvciwgcHJpdmF0ZSBvdXRwdXRDdHg6IE91dHB1dENvbnRleHQsXG4gICAgICBwcml2YXRlIHBhcmVudDogVmlld0J1aWxkZXJ8bnVsbCwgcHJpdmF0ZSBjb21wb25lbnQ6IENvbXBpbGVEaXJlY3RpdmVNZXRhZGF0YSxcbiAgICAgIHByaXZhdGUgZW1iZWRkZWRWaWV3SW5kZXg6IG51bWJlciwgcHJpdmF0ZSB1c2VkUGlwZXM6IENvbXBpbGVQaXBlU3VtbWFyeVtdLFxuICAgICAgcHJpdmF0ZSBzdGF0aWNRdWVyeUlkczogTWFwPFRlbXBsYXRlQXN0LCBTdGF0aWNBbmREeW5hbWljUXVlcnlJZHM+LFxuICAgICAgcHJpdmF0ZSB2aWV3QnVpbGRlckZhY3Rvcnk6IFZpZXdCdWlsZGVyRmFjdG9yeSkge1xuICAgIC8vIFRPRE8odGJvc2NoKTogVGhlIG9sZCB2aWV3IGNvbXBpbGVyIHVzZWQgdG8gdXNlIGFuIGBhbnlgIHR5cGVcbiAgICAvLyBmb3IgdGhlIGNvbnRleHQgaW4gYW55IGVtYmVkZGVkIHZpZXcuIFdlIGtlZXAgdGhpcyBiZWhhaXZvciBmb3Igbm93XG4gICAgLy8gdG8gYmUgYWJsZSB0byBpbnRyb2R1Y2UgdGhlIG5ldyB2aWV3IGNvbXBpbGVyIHdpdGhvdXQgdG9vIG1hbnkgZXJyb3JzLlxuICAgIHRoaXMuY29tcFR5cGUgPSB0aGlzLmVtYmVkZGVkVmlld0luZGV4ID4gMCA/XG4gICAgICAgIG8uRFlOQU1JQ19UWVBFIDpcbiAgICAgICAgby5leHByZXNzaW9uVHlwZShvdXRwdXRDdHguaW1wb3J0RXhwcih0aGlzLmNvbXBvbmVudC50eXBlLnJlZmVyZW5jZSkpICE7XG4gICAgdGhpcy52aWV3TmFtZSA9IHZpZXdDbGFzc05hbWUodGhpcy5jb21wb25lbnQudHlwZS5yZWZlcmVuY2UsIHRoaXMuZW1iZWRkZWRWaWV3SW5kZXgpO1xuICB9XG5cbiAgdmlzaXRBbGwodmFyaWFibGVzOiBWYXJpYWJsZUFzdFtdLCBhc3ROb2RlczogVGVtcGxhdGVBc3RbXSkge1xuICAgIHRoaXMudmFyaWFibGVzID0gdmFyaWFibGVzO1xuICAgIC8vIGNyZWF0ZSB0aGUgcGlwZXMgZm9yIHRoZSBwdXJlIHBpcGVzIGltbWVkaWF0ZWx5LCBzbyB0aGF0IHdlIGtub3cgdGhlaXIgaW5kaWNlcy5cbiAgICBpZiAoIXRoaXMucGFyZW50KSB7XG4gICAgICB0aGlzLnVzZWRQaXBlcy5mb3JFYWNoKChwaXBlKSA9PiB7XG4gICAgICAgIGlmIChwaXBlLnB1cmUpIHtcbiAgICAgICAgICB0aGlzLnB1cmVQaXBlTm9kZUluZGljZXNbcGlwZS5uYW1lXSA9IHRoaXMuX2NyZWF0ZVBpcGUobnVsbCwgcGlwZSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5wYXJlbnQpIHtcbiAgICAgIGNvbnN0IHF1ZXJ5SWRzID0gc3RhdGljVmlld1F1ZXJ5SWRzKHRoaXMuc3RhdGljUXVlcnlJZHMpO1xuICAgICAgdGhpcy5jb21wb25lbnQudmlld1F1ZXJpZXMuZm9yRWFjaCgocXVlcnksIHF1ZXJ5SW5kZXgpID0+IHtcbiAgICAgICAgLy8gTm90ZTogcXVlcmllcyBzdGFydCB3aXRoIGlkIDEgc28gd2UgY2FuIHVzZSB0aGUgbnVtYmVyIGluIGEgQmxvb20gZmlsdGVyIVxuICAgICAgICBjb25zdCBxdWVyeUlkID0gcXVlcnlJbmRleCArIDE7XG4gICAgICAgIGNvbnN0IGJpbmRpbmdUeXBlID0gcXVlcnkuZmlyc3QgPyBRdWVyeUJpbmRpbmdUeXBlLkZpcnN0IDogUXVlcnlCaW5kaW5nVHlwZS5BbGw7XG4gICAgICAgIGNvbnN0IGZsYWdzID1cbiAgICAgICAgICAgIE5vZGVGbGFncy5UeXBlVmlld1F1ZXJ5IHwgY2FsY1N0YXRpY0R5bmFtaWNRdWVyeUZsYWdzKHF1ZXJ5SWRzLCBxdWVyeUlkLCBxdWVyeSk7XG4gICAgICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VTcGFuOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlRmxhZ3M6IGZsYWdzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlRGVmOiBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMucXVlcnlEZWYpLmNhbGxGbihbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGZsYWdzKSwgby5saXRlcmFsKHF1ZXJ5SWQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5ldyBvLkxpdGVyYWxNYXBFeHByKFtuZXcgby5MaXRlcmFsTWFwRW50cnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5LnByb3BlcnR5TmFtZSwgby5saXRlcmFsKGJpbmRpbmdUeXBlKSwgZmFsc2UpXSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgXSlcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICB0ZW1wbGF0ZVZpc2l0QWxsKHRoaXMsIGFzdE5vZGVzKTtcbiAgICBpZiAodGhpcy5wYXJlbnQgJiYgKGFzdE5vZGVzLmxlbmd0aCA9PT0gMCB8fCBuZWVkc0FkZGl0aW9uYWxSb290Tm9kZShhc3ROb2RlcykpKSB7XG4gICAgICAvLyBpZiB0aGUgdmlldyBpcyBhbiBlbWJlZGRlZCB2aWV3LCB0aGVuIHdlIG5lZWQgdG8gYWRkIGFuIGFkZGl0aW9uYWwgcm9vdCBub2RlIGluIHNvbWUgY2FzZXNcbiAgICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlU3BhbjogbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVGbGFnczogTm9kZUZsYWdzLlR5cGVFbGVtZW50LFxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZURlZjogby5pbXBvcnRFeHByKElkZW50aWZpZXJzLmFuY2hvckRlZikuY2FsbEZuKFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKE5vZGVGbGFncy5Ob25lKSwgby5OVUxMX0VYUFIsIG8uTlVMTF9FWFBSLCBvLmxpdGVyYWwoMClcbiAgICAgICAgICAgICAgICAgICAgICAgIF0pXG4gICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgIH1cbiAgfVxuXG4gIGJ1aWxkKHRhcmdldFN0YXRlbWVudHM6IG8uU3RhdGVtZW50W10gPSBbXSk6IG8uU3RhdGVtZW50W10ge1xuICAgIHRoaXMuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IGNoaWxkLmJ1aWxkKHRhcmdldFN0YXRlbWVudHMpKTtcblxuICAgIGNvbnN0IHt1cGRhdGVSZW5kZXJlclN0bXRzLCB1cGRhdGVEaXJlY3RpdmVzU3RtdHMsIG5vZGVEZWZFeHByc30gPVxuICAgICAgICB0aGlzLl9jcmVhdGVOb2RlRXhwcmVzc2lvbnMoKTtcblxuICAgIGNvbnN0IHVwZGF0ZVJlbmRlcmVyRm4gPSB0aGlzLl9jcmVhdGVVcGRhdGVGbih1cGRhdGVSZW5kZXJlclN0bXRzKTtcbiAgICBjb25zdCB1cGRhdGVEaXJlY3RpdmVzRm4gPSB0aGlzLl9jcmVhdGVVcGRhdGVGbih1cGRhdGVEaXJlY3RpdmVzU3RtdHMpO1xuXG5cbiAgICBsZXQgdmlld0ZsYWdzID0gVmlld0ZsYWdzLk5vbmU7XG4gICAgaWYgKCF0aGlzLnBhcmVudCAmJiB0aGlzLmNvbXBvbmVudC5jaGFuZ2VEZXRlY3Rpb24gPT09IENoYW5nZURldGVjdGlvblN0cmF0ZWd5Lk9uUHVzaCkge1xuICAgICAgdmlld0ZsYWdzIHw9IFZpZXdGbGFncy5PblB1c2g7XG4gICAgfVxuICAgIGNvbnN0IHZpZXdGYWN0b3J5ID0gbmV3IG8uRGVjbGFyZUZ1bmN0aW9uU3RtdChcbiAgICAgICAgdGhpcy52aWV3TmFtZSwgW25ldyBvLkZuUGFyYW0oTE9HX1ZBUi5uYW1lICEpXSxcbiAgICAgICAgW25ldyBvLlJldHVyblN0YXRlbWVudChvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMudmlld0RlZikuY2FsbEZuKFtcbiAgICAgICAgICBvLmxpdGVyYWwodmlld0ZsYWdzKSxcbiAgICAgICAgICBvLmxpdGVyYWxBcnIobm9kZURlZkV4cHJzKSxcbiAgICAgICAgICB1cGRhdGVEaXJlY3RpdmVzRm4sXG4gICAgICAgICAgdXBkYXRlUmVuZGVyZXJGbixcbiAgICAgICAgXSkpXSxcbiAgICAgICAgby5pbXBvcnRUeXBlKElkZW50aWZpZXJzLlZpZXdEZWZpbml0aW9uKSxcbiAgICAgICAgdGhpcy5lbWJlZGRlZFZpZXdJbmRleCA9PT0gMCA/IFtvLlN0bXRNb2RpZmllci5FeHBvcnRlZF0gOiBbXSk7XG5cbiAgICB0YXJnZXRTdGF0ZW1lbnRzLnB1c2godmlld0ZhY3RvcnkpO1xuICAgIHJldHVybiB0YXJnZXRTdGF0ZW1lbnRzO1xuICB9XG5cbiAgcHJpdmF0ZSBfY3JlYXRlVXBkYXRlRm4odXBkYXRlU3RtdHM6IG8uU3RhdGVtZW50W10pOiBvLkV4cHJlc3Npb24ge1xuICAgIGxldCB1cGRhdGVGbjogby5FeHByZXNzaW9uO1xuICAgIGlmICh1cGRhdGVTdG10cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBwcmVTdG10czogby5TdGF0ZW1lbnRbXSA9IFtdO1xuICAgICAgaWYgKCF0aGlzLmNvbXBvbmVudC5pc0hvc3QgJiYgby5maW5kUmVhZFZhck5hbWVzKHVwZGF0ZVN0bXRzKS5oYXMoQ09NUF9WQVIubmFtZSAhKSkge1xuICAgICAgICBwcmVTdG10cy5wdXNoKENPTVBfVkFSLnNldChWSUVXX1ZBUi5wcm9wKCdjb21wb25lbnQnKSkudG9EZWNsU3RtdCh0aGlzLmNvbXBUeXBlKSk7XG4gICAgICB9XG4gICAgICB1cGRhdGVGbiA9IG8uZm4oXG4gICAgICAgICAgW1xuICAgICAgICAgICAgbmV3IG8uRm5QYXJhbShDSEVDS19WQVIubmFtZSAhLCBvLklORkVSUkVEX1RZUEUpLFxuICAgICAgICAgICAgbmV3IG8uRm5QYXJhbShWSUVXX1ZBUi5uYW1lICEsIG8uSU5GRVJSRURfVFlQRSlcbiAgICAgICAgICBdLFxuICAgICAgICAgIFsuLi5wcmVTdG10cywgLi4udXBkYXRlU3RtdHNdLCBvLklORkVSUkVEX1RZUEUpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1cGRhdGVGbiA9IG8uTlVMTF9FWFBSO1xuICAgIH1cbiAgICByZXR1cm4gdXBkYXRlRm47XG4gIH1cblxuICB2aXNpdE5nQ29udGVudChhc3Q6IE5nQ29udGVudEFzdCwgY29udGV4dDogYW55KTogYW55IHtcbiAgICAvLyBuZ0NvbnRlbnREZWYobmdDb250ZW50SW5kZXg6IG51bWJlciwgaW5kZXg6IG51bWJlcik6IE5vZGVEZWY7XG4gICAgdGhpcy5ub2Rlcy5wdXNoKCgpID0+ICh7XG4gICAgICAgICAgICAgICAgICAgICAgc291cmNlU3BhbjogYXN0LnNvdXJjZVNwYW4sXG4gICAgICAgICAgICAgICAgICAgICAgbm9kZUZsYWdzOiBOb2RlRmxhZ3MuVHlwZU5nQ29udGVudCxcbiAgICAgICAgICAgICAgICAgICAgICBub2RlRGVmOiBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMubmdDb250ZW50RGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGFzdC5uZ0NvbnRlbnRJbmRleCksIG8ubGl0ZXJhbChhc3QuaW5kZXgpXG4gICAgICAgICAgICAgICAgICAgICAgXSlcbiAgICAgICAgICAgICAgICAgICAgfSkpO1xuICB9XG5cbiAgdmlzaXRUZXh0KGFzdDogVGV4dEFzdCwgY29udGV4dDogYW55KTogYW55IHtcbiAgICAvLyBTdGF0aWMgdGV4dCBub2RlcyBoYXZlIG5vIGNoZWNrIGZ1bmN0aW9uXG4gICAgY29uc3QgY2hlY2tJbmRleCA9IC0xO1xuICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZVNwYW46IGFzdC5zb3VyY2VTcGFuLFxuICAgICAgICAgICAgICAgICAgICAgIG5vZGVGbGFnczogTm9kZUZsYWdzLlR5cGVUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy50ZXh0RGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGNoZWNrSW5kZXgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGFzdC5uZ0NvbnRlbnRJbmRleCksXG4gICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWxBcnIoW28ubGl0ZXJhbChhc3QudmFsdWUpXSksXG4gICAgICAgICAgICAgICAgICAgICAgXSlcbiAgICAgICAgICAgICAgICAgICAgfSkpO1xuICB9XG5cbiAgdmlzaXRCb3VuZFRleHQoYXN0OiBCb3VuZFRleHRBc3QsIGNvbnRleHQ6IGFueSk6IGFueSB7XG4gICAgY29uc3Qgbm9kZUluZGV4ID0gdGhpcy5ub2Rlcy5sZW5ndGg7XG4gICAgLy8gcmVzZXJ2ZSB0aGUgc3BhY2UgaW4gdGhlIG5vZGVEZWZzIGFycmF5XG4gICAgdGhpcy5ub2Rlcy5wdXNoKG51bGwgISk7XG5cbiAgICBjb25zdCBhc3RXaXRoU291cmNlID0gPEFTVFdpdGhTb3VyY2U+YXN0LnZhbHVlO1xuICAgIGNvbnN0IGludGVyID0gPEludGVycG9sYXRpb24+YXN0V2l0aFNvdXJjZS5hc3Q7XG5cbiAgICBjb25zdCB1cGRhdGVSZW5kZXJlckV4cHJlc3Npb25zID0gaW50ZXIuZXhwcmVzc2lvbnMubWFwKFxuICAgICAgICAoZXhwciwgYmluZGluZ0luZGV4KSA9PiB0aGlzLl9wcmVwcm9jZXNzVXBkYXRlRXhwcmVzc2lvbihcbiAgICAgICAgICAgIHtub2RlSW5kZXgsIGJpbmRpbmdJbmRleCwgc291cmNlU3BhbjogYXN0LnNvdXJjZVNwYW4sIGNvbnRleHQ6IENPTVBfVkFSLCB2YWx1ZTogZXhwcn0pKTtcblxuICAgIC8vIENoZWNrIGluZGV4IGlzIHRoZSBzYW1lIGFzIHRoZSBub2RlIGluZGV4IGR1cmluZyBjb21waWxhdGlvblxuICAgIC8vIFRoZXkgbWlnaHQgb25seSBkaWZmZXIgYXQgcnVudGltZVxuICAgIGNvbnN0IGNoZWNrSW5kZXggPSBub2RlSW5kZXg7XG5cbiAgICB0aGlzLm5vZGVzW25vZGVJbmRleF0gPSAoKSA9PiAoe1xuICAgICAgc291cmNlU3BhbjogYXN0LnNvdXJjZVNwYW4sXG4gICAgICBub2RlRmxhZ3M6IE5vZGVGbGFncy5UeXBlVGV4dCxcbiAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy50ZXh0RGVmKS5jYWxsRm4oW1xuICAgICAgICBvLmxpdGVyYWwoY2hlY2tJbmRleCksXG4gICAgICAgIG8ubGl0ZXJhbChhc3QubmdDb250ZW50SW5kZXgpLFxuICAgICAgICBvLmxpdGVyYWxBcnIoaW50ZXIuc3RyaW5ncy5tYXAocyA9PiBvLmxpdGVyYWwocykpKSxcbiAgICAgIF0pLFxuICAgICAgdXBkYXRlUmVuZGVyZXI6IHVwZGF0ZVJlbmRlcmVyRXhwcmVzc2lvbnNcbiAgICB9KTtcbiAgfVxuXG4gIHZpc2l0RW1iZWRkZWRUZW1wbGF0ZShhc3Q6IEVtYmVkZGVkVGVtcGxhdGVBc3QsIGNvbnRleHQ6IGFueSk6IGFueSB7XG4gICAgY29uc3Qgbm9kZUluZGV4ID0gdGhpcy5ub2Rlcy5sZW5ndGg7XG4gICAgLy8gcmVzZXJ2ZSB0aGUgc3BhY2UgaW4gdGhlIG5vZGVEZWZzIGFycmF5XG4gICAgdGhpcy5ub2Rlcy5wdXNoKG51bGwgISk7XG5cbiAgICBjb25zdCB7ZmxhZ3MsIHF1ZXJ5TWF0Y2hlc0V4cHIsIGhvc3RFdmVudHN9ID0gdGhpcy5fdmlzaXRFbGVtZW50T3JUZW1wbGF0ZShub2RlSW5kZXgsIGFzdCk7XG5cbiAgICBjb25zdCBjaGlsZFZpc2l0b3IgPSB0aGlzLnZpZXdCdWlsZGVyRmFjdG9yeSh0aGlzKTtcbiAgICB0aGlzLmNoaWxkcmVuLnB1c2goY2hpbGRWaXNpdG9yKTtcbiAgICBjaGlsZFZpc2l0b3IudmlzaXRBbGwoYXN0LnZhcmlhYmxlcywgYXN0LmNoaWxkcmVuKTtcblxuICAgIGNvbnN0IGNoaWxkQ291bnQgPSB0aGlzLm5vZGVzLmxlbmd0aCAtIG5vZGVJbmRleCAtIDE7XG5cbiAgICAvLyBhbmNob3JEZWYoXG4gICAgLy8gICBmbGFnczogTm9kZUZsYWdzLCBtYXRjaGVkUXVlcmllczogW3N0cmluZywgUXVlcnlWYWx1ZVR5cGVdW10sIG5nQ29udGVudEluZGV4OiBudW1iZXIsXG4gICAgLy8gICBjaGlsZENvdW50OiBudW1iZXIsIGhhbmRsZUV2ZW50Rm4/OiBFbGVtZW50SGFuZGxlRXZlbnRGbiwgdGVtcGxhdGVGYWN0b3J5PzpcbiAgICAvLyAgIFZpZXdEZWZpbml0aW9uRmFjdG9yeSk6IE5vZGVEZWY7XG4gICAgdGhpcy5ub2Rlc1tub2RlSW5kZXhdID0gKCkgPT4gKHtcbiAgICAgIHNvdXJjZVNwYW46IGFzdC5zb3VyY2VTcGFuLFxuICAgICAgbm9kZUZsYWdzOiBOb2RlRmxhZ3MuVHlwZUVsZW1lbnQgfCBmbGFncyxcbiAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5hbmNob3JEZWYpLmNhbGxGbihbXG4gICAgICAgIG8ubGl0ZXJhbChmbGFncyksXG4gICAgICAgIHF1ZXJ5TWF0Y2hlc0V4cHIsXG4gICAgICAgIG8ubGl0ZXJhbChhc3QubmdDb250ZW50SW5kZXgpLFxuICAgICAgICBvLmxpdGVyYWwoY2hpbGRDb3VudCksXG4gICAgICAgIHRoaXMuX2NyZWF0ZUVsZW1lbnRIYW5kbGVFdmVudEZuKG5vZGVJbmRleCwgaG9zdEV2ZW50cyksXG4gICAgICAgIG8udmFyaWFibGUoY2hpbGRWaXNpdG9yLnZpZXdOYW1lKSxcbiAgICAgIF0pXG4gICAgfSk7XG4gIH1cblxuICB2aXNpdEVsZW1lbnQoYXN0OiBFbGVtZW50QXN0LCBjb250ZXh0OiBhbnkpOiBhbnkge1xuICAgIGNvbnN0IG5vZGVJbmRleCA9IHRoaXMubm9kZXMubGVuZ3RoO1xuICAgIC8vIHJlc2VydmUgdGhlIHNwYWNlIGluIHRoZSBub2RlRGVmcyBhcnJheSBzbyB3ZSBjYW4gYWRkIGNoaWxkcmVuXG4gICAgdGhpcy5ub2Rlcy5wdXNoKG51bGwgISk7XG5cbiAgICAvLyBVc2luZyBhIG51bGwgZWxlbWVudCBuYW1lIGNyZWF0ZXMgYW4gYW5jaG9yLlxuICAgIGNvbnN0IGVsTmFtZTogc3RyaW5nfG51bGwgPSBpc05nQ29udGFpbmVyKGFzdC5uYW1lKSA/IG51bGwgOiBhc3QubmFtZTtcblxuICAgIGNvbnN0IHtmbGFncywgdXNlZEV2ZW50cywgcXVlcnlNYXRjaGVzRXhwciwgaG9zdEJpbmRpbmdzOiBkaXJIb3N0QmluZGluZ3MsIGhvc3RFdmVudHN9ID1cbiAgICAgICAgdGhpcy5fdmlzaXRFbGVtZW50T3JUZW1wbGF0ZShub2RlSW5kZXgsIGFzdCk7XG5cbiAgICBsZXQgaW5wdXREZWZzOiBvLkV4cHJlc3Npb25bXSA9IFtdO1xuICAgIGxldCB1cGRhdGVSZW5kZXJlckV4cHJlc3Npb25zOiBVcGRhdGVFeHByZXNzaW9uW10gPSBbXTtcbiAgICBsZXQgb3V0cHV0RGVmczogby5FeHByZXNzaW9uW10gPSBbXTtcbiAgICBpZiAoZWxOYW1lKSB7XG4gICAgICBjb25zdCBob3N0QmluZGluZ3M6IGFueVtdID0gYXN0LmlucHV0c1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWFwKChpbnB1dEFzdCkgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IENPTVBfVkFSIGFzIG8uRXhwcmVzc2lvbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0QXN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlyQXN0OiBudWxsIGFzIGFueSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLmNvbmNhdChkaXJIb3N0QmluZGluZ3MpO1xuICAgICAgaWYgKGhvc3RCaW5kaW5ncy5sZW5ndGgpIHtcbiAgICAgICAgdXBkYXRlUmVuZGVyZXJFeHByZXNzaW9ucyA9XG4gICAgICAgICAgICBob3N0QmluZGluZ3MubWFwKChob3N0QmluZGluZywgYmluZGluZ0luZGV4KSA9PiB0aGlzLl9wcmVwcm9jZXNzVXBkYXRlRXhwcmVzc2lvbih7XG4gICAgICAgICAgICAgIGNvbnRleHQ6IGhvc3RCaW5kaW5nLmNvbnRleHQsXG4gICAgICAgICAgICAgIG5vZGVJbmRleCxcbiAgICAgICAgICAgICAgYmluZGluZ0luZGV4LFxuICAgICAgICAgICAgICBzb3VyY2VTcGFuOiBob3N0QmluZGluZy5pbnB1dEFzdC5zb3VyY2VTcGFuLFxuICAgICAgICAgICAgICB2YWx1ZTogaG9zdEJpbmRpbmcuaW5wdXRBc3QudmFsdWVcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgaW5wdXREZWZzID0gaG9zdEJpbmRpbmdzLm1hcChcbiAgICAgICAgICAgIGhvc3RCaW5kaW5nID0+IGVsZW1lbnRCaW5kaW5nRGVmKGhvc3RCaW5kaW5nLmlucHV0QXN0LCBob3N0QmluZGluZy5kaXJBc3QpKTtcbiAgICAgIH1cbiAgICAgIG91dHB1dERlZnMgPSB1c2VkRXZlbnRzLm1hcChcbiAgICAgICAgICAoW3RhcmdldCwgZXZlbnROYW1lXSkgPT4gby5saXRlcmFsQXJyKFtvLmxpdGVyYWwodGFyZ2V0KSwgby5saXRlcmFsKGV2ZW50TmFtZSldKSk7XG4gICAgfVxuXG4gICAgdGVtcGxhdGVWaXNpdEFsbCh0aGlzLCBhc3QuY2hpbGRyZW4pO1xuXG4gICAgY29uc3QgY2hpbGRDb3VudCA9IHRoaXMubm9kZXMubGVuZ3RoIC0gbm9kZUluZGV4IC0gMTtcblxuICAgIGNvbnN0IGNvbXBBc3QgPSBhc3QuZGlyZWN0aXZlcy5maW5kKGRpckFzdCA9PiBkaXJBc3QuZGlyZWN0aXZlLmlzQ29tcG9uZW50KTtcbiAgICBsZXQgY29tcFJlbmRlcmVyVHlwZSA9IG8uTlVMTF9FWFBSIGFzIG8uRXhwcmVzc2lvbjtcbiAgICBsZXQgY29tcFZpZXcgPSBvLk5VTExfRVhQUiBhcyBvLkV4cHJlc3Npb247XG4gICAgaWYgKGNvbXBBc3QpIHtcbiAgICAgIGNvbXBWaWV3ID0gdGhpcy5vdXRwdXRDdHguaW1wb3J0RXhwcihjb21wQXN0LmRpcmVjdGl2ZS5jb21wb25lbnRWaWV3VHlwZSk7XG4gICAgICBjb21wUmVuZGVyZXJUeXBlID0gdGhpcy5vdXRwdXRDdHguaW1wb3J0RXhwcihjb21wQXN0LmRpcmVjdGl2ZS5yZW5kZXJlclR5cGUpO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGluZGV4IGlzIHRoZSBzYW1lIGFzIHRoZSBub2RlIGluZGV4IGR1cmluZyBjb21waWxhdGlvblxuICAgIC8vIFRoZXkgbWlnaHQgb25seSBkaWZmZXIgYXQgcnVudGltZVxuICAgIGNvbnN0IGNoZWNrSW5kZXggPSBub2RlSW5kZXg7XG5cbiAgICB0aGlzLm5vZGVzW25vZGVJbmRleF0gPSAoKSA9PiAoe1xuICAgICAgc291cmNlU3BhbjogYXN0LnNvdXJjZVNwYW4sXG4gICAgICBub2RlRmxhZ3M6IE5vZGVGbGFncy5UeXBlRWxlbWVudCB8IGZsYWdzLFxuICAgICAgbm9kZURlZjogby5pbXBvcnRFeHByKElkZW50aWZpZXJzLmVsZW1lbnREZWYpLmNhbGxGbihbXG4gICAgICAgIG8ubGl0ZXJhbChjaGVja0luZGV4KSxcbiAgICAgICAgby5saXRlcmFsKGZsYWdzKSxcbiAgICAgICAgcXVlcnlNYXRjaGVzRXhwcixcbiAgICAgICAgby5saXRlcmFsKGFzdC5uZ0NvbnRlbnRJbmRleCksXG4gICAgICAgIG8ubGl0ZXJhbChjaGlsZENvdW50KSxcbiAgICAgICAgby5saXRlcmFsKGVsTmFtZSksXG4gICAgICAgIGVsTmFtZSA/IGZpeGVkQXR0cnNEZWYoYXN0KSA6IG8uTlVMTF9FWFBSLFxuICAgICAgICBpbnB1dERlZnMubGVuZ3RoID8gby5saXRlcmFsQXJyKGlucHV0RGVmcykgOiBvLk5VTExfRVhQUixcbiAgICAgICAgb3V0cHV0RGVmcy5sZW5ndGggPyBvLmxpdGVyYWxBcnIob3V0cHV0RGVmcykgOiBvLk5VTExfRVhQUixcbiAgICAgICAgdGhpcy5fY3JlYXRlRWxlbWVudEhhbmRsZUV2ZW50Rm4obm9kZUluZGV4LCBob3N0RXZlbnRzKSxcbiAgICAgICAgY29tcFZpZXcsXG4gICAgICAgIGNvbXBSZW5kZXJlclR5cGUsXG4gICAgICBdKSxcbiAgICAgIHVwZGF0ZVJlbmRlcmVyOiB1cGRhdGVSZW5kZXJlckV4cHJlc3Npb25zXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF92aXNpdEVsZW1lbnRPclRlbXBsYXRlKG5vZGVJbmRleDogbnVtYmVyLCBhc3Q6IHtcbiAgICBoYXNWaWV3Q29udGFpbmVyOiBib29sZWFuLFxuICAgIG91dHB1dHM6IEJvdW5kRXZlbnRBc3RbXSxcbiAgICBkaXJlY3RpdmVzOiBEaXJlY3RpdmVBc3RbXSxcbiAgICBwcm92aWRlcnM6IFByb3ZpZGVyQXN0W10sXG4gICAgcmVmZXJlbmNlczogUmVmZXJlbmNlQXN0W10sXG4gICAgcXVlcnlNYXRjaGVzOiBRdWVyeU1hdGNoW11cbiAgfSk6IHtcbiAgICBmbGFnczogTm9kZUZsYWdzLFxuICAgIHVzZWRFdmVudHM6IFtzdHJpbmcgfCBudWxsLCBzdHJpbmddW10sXG4gICAgcXVlcnlNYXRjaGVzRXhwcjogby5FeHByZXNzaW9uLFxuICAgIGhvc3RCaW5kaW5nczpcbiAgICAgICAge2NvbnRleHQ6IG8uRXhwcmVzc2lvbiwgaW5wdXRBc3Q6IEJvdW5kRWxlbWVudFByb3BlcnR5QXN0LCBkaXJBc3Q6IERpcmVjdGl2ZUFzdH1bXSxcbiAgICBob3N0RXZlbnRzOiB7Y29udGV4dDogby5FeHByZXNzaW9uLCBldmVudEFzdDogQm91bmRFdmVudEFzdCwgZGlyQXN0OiBEaXJlY3RpdmVBc3R9W10sXG4gIH0ge1xuICAgIGxldCBmbGFncyA9IE5vZGVGbGFncy5Ob25lO1xuICAgIGlmIChhc3QuaGFzVmlld0NvbnRhaW5lcikge1xuICAgICAgZmxhZ3MgfD0gTm9kZUZsYWdzLkVtYmVkZGVkVmlld3M7XG4gICAgfVxuICAgIGNvbnN0IHVzZWRFdmVudHMgPSBuZXcgTWFwPHN0cmluZywgW3N0cmluZyB8IG51bGwsIHN0cmluZ10+KCk7XG4gICAgYXN0Lm91dHB1dHMuZm9yRWFjaCgoZXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IHtuYW1lLCB0YXJnZXR9ID0gZWxlbWVudEV2ZW50TmFtZUFuZFRhcmdldChldmVudCwgbnVsbCk7XG4gICAgICB1c2VkRXZlbnRzLnNldChlbGVtZW50RXZlbnRGdWxsTmFtZSh0YXJnZXQsIG5hbWUpLCBbdGFyZ2V0LCBuYW1lXSk7XG4gICAgfSk7XG4gICAgYXN0LmRpcmVjdGl2ZXMuZm9yRWFjaCgoZGlyQXN0KSA9PiB7XG4gICAgICBkaXJBc3QuaG9zdEV2ZW50cy5mb3JFYWNoKChldmVudCkgPT4ge1xuICAgICAgICBjb25zdCB7bmFtZSwgdGFyZ2V0fSA9IGVsZW1lbnRFdmVudE5hbWVBbmRUYXJnZXQoZXZlbnQsIGRpckFzdCk7XG4gICAgICAgIHVzZWRFdmVudHMuc2V0KGVsZW1lbnRFdmVudEZ1bGxOYW1lKHRhcmdldCwgbmFtZSksIFt0YXJnZXQsIG5hbWVdKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIGNvbnN0IGhvc3RCaW5kaW5nczpcbiAgICAgICAge2NvbnRleHQ6IG8uRXhwcmVzc2lvbiwgaW5wdXRBc3Q6IEJvdW5kRWxlbWVudFByb3BlcnR5QXN0LCBkaXJBc3Q6IERpcmVjdGl2ZUFzdH1bXSA9IFtdO1xuICAgIGNvbnN0IGhvc3RFdmVudHM6IHtjb250ZXh0OiBvLkV4cHJlc3Npb24sIGV2ZW50QXN0OiBCb3VuZEV2ZW50QXN0LCBkaXJBc3Q6IERpcmVjdGl2ZUFzdH1bXSA9IFtdO1xuICAgIHRoaXMuX3Zpc2l0Q29tcG9uZW50RmFjdG9yeVJlc29sdmVyUHJvdmlkZXIoYXN0LmRpcmVjdGl2ZXMpO1xuXG4gICAgYXN0LnByb3ZpZGVycy5mb3JFYWNoKChwcm92aWRlckFzdCwgcHJvdmlkZXJJbmRleCkgPT4ge1xuICAgICAgbGV0IGRpckFzdDogRGlyZWN0aXZlQXN0ID0gdW5kZWZpbmVkICE7XG4gICAgICBsZXQgZGlySW5kZXg6IG51bWJlciA9IHVuZGVmaW5lZCAhO1xuICAgICAgYXN0LmRpcmVjdGl2ZXMuZm9yRWFjaCgobG9jYWxEaXJBc3QsIGkpID0+IHtcbiAgICAgICAgaWYgKGxvY2FsRGlyQXN0LmRpcmVjdGl2ZS50eXBlLnJlZmVyZW5jZSA9PT0gdG9rZW5SZWZlcmVuY2UocHJvdmlkZXJBc3QudG9rZW4pKSB7XG4gICAgICAgICAgZGlyQXN0ID0gbG9jYWxEaXJBc3Q7XG4gICAgICAgICAgZGlySW5kZXggPSBpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChkaXJBc3QpIHtcbiAgICAgICAgY29uc3Qge2hvc3RCaW5kaW5nczogZGlySG9zdEJpbmRpbmdzLCBob3N0RXZlbnRzOiBkaXJIb3N0RXZlbnRzfSA9IHRoaXMuX3Zpc2l0RGlyZWN0aXZlKFxuICAgICAgICAgICAgcHJvdmlkZXJBc3QsIGRpckFzdCwgZGlySW5kZXgsIG5vZGVJbmRleCwgYXN0LnJlZmVyZW5jZXMsIGFzdC5xdWVyeU1hdGNoZXMsIHVzZWRFdmVudHMsXG4gICAgICAgICAgICB0aGlzLnN0YXRpY1F1ZXJ5SWRzLmdldCg8YW55PmFzdCkgISk7XG4gICAgICAgIGhvc3RCaW5kaW5ncy5wdXNoKC4uLmRpckhvc3RCaW5kaW5ncyk7XG4gICAgICAgIGhvc3RFdmVudHMucHVzaCguLi5kaXJIb3N0RXZlbnRzKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX3Zpc2l0UHJvdmlkZXIocHJvdmlkZXJBc3QsIGFzdC5xdWVyeU1hdGNoZXMpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgbGV0IHF1ZXJ5TWF0Y2hFeHByczogby5FeHByZXNzaW9uW10gPSBbXTtcbiAgICBhc3QucXVlcnlNYXRjaGVzLmZvckVhY2goKG1hdGNoKSA9PiB7XG4gICAgICBsZXQgdmFsdWVUeXBlOiBRdWVyeVZhbHVlVHlwZSA9IHVuZGVmaW5lZCAhO1xuICAgICAgaWYgKHRva2VuUmVmZXJlbmNlKG1hdGNoLnZhbHVlKSA9PT1cbiAgICAgICAgICB0aGlzLnJlZmxlY3Rvci5yZXNvbHZlRXh0ZXJuYWxSZWZlcmVuY2UoSWRlbnRpZmllcnMuRWxlbWVudFJlZikpIHtcbiAgICAgICAgdmFsdWVUeXBlID0gUXVlcnlWYWx1ZVR5cGUuRWxlbWVudFJlZjtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgdG9rZW5SZWZlcmVuY2UobWF0Y2gudmFsdWUpID09PVxuICAgICAgICAgIHRoaXMucmVmbGVjdG9yLnJlc29sdmVFeHRlcm5hbFJlZmVyZW5jZShJZGVudGlmaWVycy5WaWV3Q29udGFpbmVyUmVmKSkge1xuICAgICAgICB2YWx1ZVR5cGUgPSBRdWVyeVZhbHVlVHlwZS5WaWV3Q29udGFpbmVyUmVmO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICB0b2tlblJlZmVyZW5jZShtYXRjaC52YWx1ZSkgPT09XG4gICAgICAgICAgdGhpcy5yZWZsZWN0b3IucmVzb2x2ZUV4dGVybmFsUmVmZXJlbmNlKElkZW50aWZpZXJzLlRlbXBsYXRlUmVmKSkge1xuICAgICAgICB2YWx1ZVR5cGUgPSBRdWVyeVZhbHVlVHlwZS5UZW1wbGF0ZVJlZjtcbiAgICAgIH1cbiAgICAgIGlmICh2YWx1ZVR5cGUgIT0gbnVsbCkge1xuICAgICAgICBxdWVyeU1hdGNoRXhwcnMucHVzaChvLmxpdGVyYWxBcnIoW28ubGl0ZXJhbChtYXRjaC5xdWVyeUlkKSwgby5saXRlcmFsKHZhbHVlVHlwZSldKSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgYXN0LnJlZmVyZW5jZXMuZm9yRWFjaCgocmVmKSA9PiB7XG4gICAgICBsZXQgdmFsdWVUeXBlOiBRdWVyeVZhbHVlVHlwZSA9IHVuZGVmaW5lZCAhO1xuICAgICAgaWYgKCFyZWYudmFsdWUpIHtcbiAgICAgICAgdmFsdWVUeXBlID0gUXVlcnlWYWx1ZVR5cGUuUmVuZGVyRWxlbWVudDtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgdG9rZW5SZWZlcmVuY2UocmVmLnZhbHVlKSA9PT1cbiAgICAgICAgICB0aGlzLnJlZmxlY3Rvci5yZXNvbHZlRXh0ZXJuYWxSZWZlcmVuY2UoSWRlbnRpZmllcnMuVGVtcGxhdGVSZWYpKSB7XG4gICAgICAgIHZhbHVlVHlwZSA9IFF1ZXJ5VmFsdWVUeXBlLlRlbXBsYXRlUmVmO1xuICAgICAgfVxuICAgICAgaWYgKHZhbHVlVHlwZSAhPSBudWxsKSB7XG4gICAgICAgIHRoaXMucmVmTm9kZUluZGljZXNbcmVmLm5hbWVdID0gbm9kZUluZGV4O1xuICAgICAgICBxdWVyeU1hdGNoRXhwcnMucHVzaChvLmxpdGVyYWxBcnIoW28ubGl0ZXJhbChyZWYubmFtZSksIG8ubGl0ZXJhbCh2YWx1ZVR5cGUpXSkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGFzdC5vdXRwdXRzLmZvckVhY2goKG91dHB1dEFzdCkgPT4ge1xuICAgICAgaG9zdEV2ZW50cy5wdXNoKHtjb250ZXh0OiBDT01QX1ZBUiwgZXZlbnRBc3Q6IG91dHB1dEFzdCwgZGlyQXN0OiBudWxsICF9KTtcbiAgICB9KTtcblxuICAgIHJldHVybiB7XG4gICAgICBmbGFncyxcbiAgICAgIHVzZWRFdmVudHM6IEFycmF5LmZyb20odXNlZEV2ZW50cy52YWx1ZXMoKSksXG4gICAgICBxdWVyeU1hdGNoZXNFeHByOiBxdWVyeU1hdGNoRXhwcnMubGVuZ3RoID8gby5saXRlcmFsQXJyKHF1ZXJ5TWF0Y2hFeHBycykgOiBvLk5VTExfRVhQUixcbiAgICAgIGhvc3RCaW5kaW5ncyxcbiAgICAgIGhvc3RFdmVudHM6IGhvc3RFdmVudHNcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBfdmlzaXREaXJlY3RpdmUoXG4gICAgICBwcm92aWRlckFzdDogUHJvdmlkZXJBc3QsIGRpckFzdDogRGlyZWN0aXZlQXN0LCBkaXJlY3RpdmVJbmRleDogbnVtYmVyLFxuICAgICAgZWxlbWVudE5vZGVJbmRleDogbnVtYmVyLCByZWZzOiBSZWZlcmVuY2VBc3RbXSwgcXVlcnlNYXRjaGVzOiBRdWVyeU1hdGNoW10sXG4gICAgICB1c2VkRXZlbnRzOiBNYXA8c3RyaW5nLCBhbnk+LCBxdWVyeUlkczogU3RhdGljQW5kRHluYW1pY1F1ZXJ5SWRzKToge1xuICAgIGhvc3RCaW5kaW5nczpcbiAgICAgICAge2NvbnRleHQ6IG8uRXhwcmVzc2lvbiwgaW5wdXRBc3Q6IEJvdW5kRWxlbWVudFByb3BlcnR5QXN0LCBkaXJBc3Q6IERpcmVjdGl2ZUFzdH1bXSxcbiAgICBob3N0RXZlbnRzOiB7Y29udGV4dDogby5FeHByZXNzaW9uLCBldmVudEFzdDogQm91bmRFdmVudEFzdCwgZGlyQXN0OiBEaXJlY3RpdmVBc3R9W11cbiAgfSB7XG4gICAgY29uc3Qgbm9kZUluZGV4ID0gdGhpcy5ub2Rlcy5sZW5ndGg7XG4gICAgLy8gcmVzZXJ2ZSB0aGUgc3BhY2UgaW4gdGhlIG5vZGVEZWZzIGFycmF5IHNvIHdlIGNhbiBhZGQgY2hpbGRyZW5cbiAgICB0aGlzLm5vZGVzLnB1c2gobnVsbCAhKTtcblxuICAgIGRpckFzdC5kaXJlY3RpdmUucXVlcmllcy5mb3JFYWNoKChxdWVyeSwgcXVlcnlJbmRleCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnlJZCA9IGRpckFzdC5jb250ZW50UXVlcnlTdGFydElkICsgcXVlcnlJbmRleDtcbiAgICAgIGNvbnN0IGZsYWdzID1cbiAgICAgICAgICBOb2RlRmxhZ3MuVHlwZUNvbnRlbnRRdWVyeSB8IGNhbGNTdGF0aWNEeW5hbWljUXVlcnlGbGFncyhxdWVyeUlkcywgcXVlcnlJZCwgcXVlcnkpO1xuICAgICAgY29uc3QgYmluZGluZ1R5cGUgPSBxdWVyeS5maXJzdCA/IFF1ZXJ5QmluZGluZ1R5cGUuRmlyc3QgOiBRdWVyeUJpbmRpbmdUeXBlLkFsbDtcbiAgICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlU3BhbjogZGlyQXN0LnNvdXJjZVNwYW4sXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlRmxhZ3M6IGZsYWdzLFxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZURlZjogby5pbXBvcnRFeHByKElkZW50aWZpZXJzLnF1ZXJ5RGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwoZmxhZ3MpLCBvLmxpdGVyYWwocXVlcnlJZCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgIG5ldyBvLkxpdGVyYWxNYXBFeHByKFtuZXcgby5MaXRlcmFsTWFwRW50cnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBxdWVyeS5wcm9wZXJ0eU5hbWUsIG8ubGl0ZXJhbChiaW5kaW5nVHlwZSksIGZhbHNlKV0pXG4gICAgICAgICAgICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyBOb3RlOiB0aGUgb3BlcmF0aW9uIGJlbG93IG1pZ2h0IGFsc28gY3JlYXRlIG5ldyBub2RlRGVmcyxcbiAgICAvLyBidXQgd2UgZG9uJ3Qgd2FudCB0aGVtIHRvIGJlIGEgY2hpbGQgb2YgYSBkaXJlY3RpdmUsXG4gICAgLy8gYXMgdGhleSBtaWdodCBiZSBhIHByb3ZpZGVyL3BpcGUgb24gdGhlaXIgb3duLlxuICAgIC8vIEkuZS4gd2Ugb25seSBhbGxvdyBxdWVyaWVzIGFzIGNoaWxkcmVuIG9mIGRpcmVjdGl2ZXMgbm9kZXMuXG4gICAgY29uc3QgY2hpbGRDb3VudCA9IHRoaXMubm9kZXMubGVuZ3RoIC0gbm9kZUluZGV4IC0gMTtcblxuICAgIGxldCB7ZmxhZ3MsIHF1ZXJ5TWF0Y2hFeHBycywgcHJvdmlkZXJFeHByLCBkZXBzRXhwcn0gPVxuICAgICAgICB0aGlzLl92aXNpdFByb3ZpZGVyT3JEaXJlY3RpdmUocHJvdmlkZXJBc3QsIHF1ZXJ5TWF0Y2hlcyk7XG5cbiAgICByZWZzLmZvckVhY2goKHJlZikgPT4ge1xuICAgICAgaWYgKHJlZi52YWx1ZSAmJiB0b2tlblJlZmVyZW5jZShyZWYudmFsdWUpID09PSB0b2tlblJlZmVyZW5jZShwcm92aWRlckFzdC50b2tlbikpIHtcbiAgICAgICAgdGhpcy5yZWZOb2RlSW5kaWNlc1tyZWYubmFtZV0gPSBub2RlSW5kZXg7XG4gICAgICAgIHF1ZXJ5TWF0Y2hFeHBycy5wdXNoKFxuICAgICAgICAgICAgby5saXRlcmFsQXJyKFtvLmxpdGVyYWwocmVmLm5hbWUpLCBvLmxpdGVyYWwoUXVlcnlWYWx1ZVR5cGUuUHJvdmlkZXIpXSkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGRpckFzdC5kaXJlY3RpdmUuaXNDb21wb25lbnQpIHtcbiAgICAgIGZsYWdzIHw9IE5vZGVGbGFncy5Db21wb25lbnQ7XG4gICAgfVxuXG4gICAgY29uc3QgaW5wdXREZWZzID0gZGlyQXN0LmlucHV0cy5tYXAoKGlucHV0QXN0LCBpbnB1dEluZGV4KSA9PiB7XG4gICAgICBjb25zdCBtYXBWYWx1ZSA9IG8ubGl0ZXJhbEFycihbby5saXRlcmFsKGlucHV0SW5kZXgpLCBvLmxpdGVyYWwoaW5wdXRBc3QuZGlyZWN0aXZlTmFtZSldKTtcbiAgICAgIC8vIE5vdGU6IGl0J3MgaW1wb3J0YW50IHRvIG5vdCBxdW90ZSB0aGUga2V5IHNvIHRoYXQgd2UgY2FuIGNhcHR1cmUgcmVuYW1lcyBieSBtaW5pZmllcnMhXG4gICAgICByZXR1cm4gbmV3IG8uTGl0ZXJhbE1hcEVudHJ5KGlucHV0QXN0LmRpcmVjdGl2ZU5hbWUsIG1hcFZhbHVlLCBmYWxzZSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBvdXRwdXREZWZzOiBvLkxpdGVyYWxNYXBFbnRyeVtdID0gW107XG4gICAgY29uc3QgZGlyTWV0YSA9IGRpckFzdC5kaXJlY3RpdmU7XG4gICAgT2JqZWN0LmtleXMoZGlyTWV0YS5vdXRwdXRzKS5mb3JFYWNoKChwcm9wTmFtZSkgPT4ge1xuICAgICAgY29uc3QgZXZlbnROYW1lID0gZGlyTWV0YS5vdXRwdXRzW3Byb3BOYW1lXTtcbiAgICAgIGlmICh1c2VkRXZlbnRzLmhhcyhldmVudE5hbWUpKSB7XG4gICAgICAgIC8vIE5vdGU6IGl0J3MgaW1wb3J0YW50IHRvIG5vdCBxdW90ZSB0aGUga2V5IHNvIHRoYXQgd2UgY2FuIGNhcHR1cmUgcmVuYW1lcyBieSBtaW5pZmllcnMhXG4gICAgICAgIG91dHB1dERlZnMucHVzaChuZXcgby5MaXRlcmFsTWFwRW50cnkocHJvcE5hbWUsIG8ubGl0ZXJhbChldmVudE5hbWUpLCBmYWxzZSkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGxldCB1cGRhdGVEaXJlY3RpdmVFeHByZXNzaW9uczogVXBkYXRlRXhwcmVzc2lvbltdID0gW107XG4gICAgaWYgKGRpckFzdC5pbnB1dHMubGVuZ3RoIHx8IChmbGFncyAmIChOb2RlRmxhZ3MuRG9DaGVjayB8IE5vZGVGbGFncy5PbkluaXQpKSA+IDApIHtcbiAgICAgIHVwZGF0ZURpcmVjdGl2ZUV4cHJlc3Npb25zID1cbiAgICAgICAgICBkaXJBc3QuaW5wdXRzLm1hcCgoaW5wdXQsIGJpbmRpbmdJbmRleCkgPT4gdGhpcy5fcHJlcHJvY2Vzc1VwZGF0ZUV4cHJlc3Npb24oe1xuICAgICAgICAgICAgbm9kZUluZGV4LFxuICAgICAgICAgICAgYmluZGluZ0luZGV4LFxuICAgICAgICAgICAgc291cmNlU3BhbjogaW5wdXQuc291cmNlU3BhbixcbiAgICAgICAgICAgIGNvbnRleHQ6IENPTVBfVkFSLFxuICAgICAgICAgICAgdmFsdWU6IGlucHV0LnZhbHVlXG4gICAgICAgICAgfSkpO1xuICAgIH1cblxuICAgIGNvbnN0IGRpckNvbnRleHRFeHByID1cbiAgICAgICAgby5pbXBvcnRFeHByKElkZW50aWZpZXJzLm5vZGVWYWx1ZSkuY2FsbEZuKFtWSUVXX1ZBUiwgby5saXRlcmFsKG5vZGVJbmRleCldKTtcbiAgICBjb25zdCBob3N0QmluZGluZ3MgPSBkaXJBc3QuaG9zdFByb3BlcnRpZXMubWFwKChpbnB1dEFzdCkgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dDogZGlyQ29udGV4dEV4cHIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpckFzdCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5wdXRBc3QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgY29uc3QgaG9zdEV2ZW50cyA9IGRpckFzdC5ob3N0RXZlbnRzLm1hcCgoaG9zdEV2ZW50QXN0KSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBkaXJDb250ZXh0RXhwcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXZlbnRBc3Q6IGhvc3RFdmVudEFzdCwgZGlyQXN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgLy8gQ2hlY2sgaW5kZXggaXMgdGhlIHNhbWUgYXMgdGhlIG5vZGUgaW5kZXggZHVyaW5nIGNvbXBpbGF0aW9uXG4gICAgLy8gVGhleSBtaWdodCBvbmx5IGRpZmZlciBhdCBydW50aW1lXG4gICAgY29uc3QgY2hlY2tJbmRleCA9IG5vZGVJbmRleDtcblxuICAgIHRoaXMubm9kZXNbbm9kZUluZGV4XSA9ICgpID0+ICh7XG4gICAgICBzb3VyY2VTcGFuOiBkaXJBc3Quc291cmNlU3BhbixcbiAgICAgIG5vZGVGbGFnczogTm9kZUZsYWdzLlR5cGVEaXJlY3RpdmUgfCBmbGFncyxcbiAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5kaXJlY3RpdmVEZWYpLmNhbGxGbihbXG4gICAgICAgIG8ubGl0ZXJhbChjaGVja0luZGV4KSxcbiAgICAgICAgby5saXRlcmFsKGZsYWdzKSxcbiAgICAgICAgcXVlcnlNYXRjaEV4cHJzLmxlbmd0aCA/IG8ubGl0ZXJhbEFycihxdWVyeU1hdGNoRXhwcnMpIDogby5OVUxMX0VYUFIsXG4gICAgICAgIG8ubGl0ZXJhbChjaGlsZENvdW50KSxcbiAgICAgICAgcHJvdmlkZXJFeHByLFxuICAgICAgICBkZXBzRXhwcixcbiAgICAgICAgaW5wdXREZWZzLmxlbmd0aCA/IG5ldyBvLkxpdGVyYWxNYXBFeHByKGlucHV0RGVmcykgOiBvLk5VTExfRVhQUixcbiAgICAgICAgb3V0cHV0RGVmcy5sZW5ndGggPyBuZXcgby5MaXRlcmFsTWFwRXhwcihvdXRwdXREZWZzKSA6IG8uTlVMTF9FWFBSLFxuICAgICAgXSksXG4gICAgICB1cGRhdGVEaXJlY3RpdmVzOiB1cGRhdGVEaXJlY3RpdmVFeHByZXNzaW9ucyxcbiAgICAgIGRpcmVjdGl2ZTogZGlyQXN0LmRpcmVjdGl2ZS50eXBlLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHtob3N0QmluZGluZ3MsIGhvc3RFdmVudHN9O1xuICB9XG5cbiAgcHJpdmF0ZSBfdmlzaXRQcm92aWRlcihwcm92aWRlckFzdDogUHJvdmlkZXJBc3QsIHF1ZXJ5TWF0Y2hlczogUXVlcnlNYXRjaFtdKTogdm9pZCB7XG4gICAgdGhpcy5fYWRkUHJvdmlkZXJOb2RlKHRoaXMuX3Zpc2l0UHJvdmlkZXJPckRpcmVjdGl2ZShwcm92aWRlckFzdCwgcXVlcnlNYXRjaGVzKSk7XG4gIH1cblxuICBwcml2YXRlIF92aXNpdENvbXBvbmVudEZhY3RvcnlSZXNvbHZlclByb3ZpZGVyKGRpcmVjdGl2ZXM6IERpcmVjdGl2ZUFzdFtdKSB7XG4gICAgY29uc3QgY29tcG9uZW50RGlyTWV0YSA9IGRpcmVjdGl2ZXMuZmluZChkaXJBc3QgPT4gZGlyQXN0LmRpcmVjdGl2ZS5pc0NvbXBvbmVudCk7XG4gICAgaWYgKGNvbXBvbmVudERpck1ldGEgJiYgY29tcG9uZW50RGlyTWV0YS5kaXJlY3RpdmUuZW50cnlDb21wb25lbnRzLmxlbmd0aCkge1xuICAgICAgY29uc3Qge3Byb3ZpZGVyRXhwciwgZGVwc0V4cHIsIGZsYWdzLCB0b2tlbkV4cHJ9ID0gY29tcG9uZW50RmFjdG9yeVJlc29sdmVyUHJvdmlkZXJEZWYoXG4gICAgICAgICAgdGhpcy5yZWZsZWN0b3IsIHRoaXMub3V0cHV0Q3R4LCBOb2RlRmxhZ3MuUHJpdmF0ZVByb3ZpZGVyLFxuICAgICAgICAgIGNvbXBvbmVudERpck1ldGEuZGlyZWN0aXZlLmVudHJ5Q29tcG9uZW50cyk7XG4gICAgICB0aGlzLl9hZGRQcm92aWRlck5vZGUoe1xuICAgICAgICBwcm92aWRlckV4cHIsXG4gICAgICAgIGRlcHNFeHByLFxuICAgICAgICBmbGFncyxcbiAgICAgICAgdG9rZW5FeHByLFxuICAgICAgICBxdWVyeU1hdGNoRXhwcnM6IFtdLFxuICAgICAgICBzb3VyY2VTcGFuOiBjb21wb25lbnREaXJNZXRhLnNvdXJjZVNwYW5cbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2FkZFByb3ZpZGVyTm9kZShkYXRhOiB7XG4gICAgZmxhZ3M6IE5vZGVGbGFncyxcbiAgICBxdWVyeU1hdGNoRXhwcnM6IG8uRXhwcmVzc2lvbltdLFxuICAgIHByb3ZpZGVyRXhwcjogby5FeHByZXNzaW9uLFxuICAgIGRlcHNFeHByOiBvLkV4cHJlc3Npb24sXG4gICAgdG9rZW5FeHByOiBvLkV4cHJlc3Npb24sXG4gICAgc291cmNlU3BhbjogUGFyc2VTb3VyY2VTcGFuXG4gIH0pIHtcbiAgICBjb25zdCBub2RlSW5kZXggPSB0aGlzLm5vZGVzLmxlbmd0aDtcbiAgICAvLyBwcm92aWRlckRlZihcbiAgICAvLyAgIGZsYWdzOiBOb2RlRmxhZ3MsIG1hdGNoZWRRdWVyaWVzOiBbc3RyaW5nLCBRdWVyeVZhbHVlVHlwZV1bXSwgdG9rZW46YW55LFxuICAgIC8vICAgdmFsdWU6IGFueSwgZGVwczogKFtEZXBGbGFncywgYW55XSB8IGFueSlbXSk6IE5vZGVEZWY7XG4gICAgdGhpcy5ub2Rlcy5wdXNoKFxuICAgICAgICAoKSA9PiAoe1xuICAgICAgICAgIHNvdXJjZVNwYW46IGRhdGEuc291cmNlU3BhbixcbiAgICAgICAgICBub2RlRmxhZ3M6IGRhdGEuZmxhZ3MsXG4gICAgICAgICAgbm9kZURlZjogby5pbXBvcnRFeHByKElkZW50aWZpZXJzLnByb3ZpZGVyRGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgby5saXRlcmFsKGRhdGEuZmxhZ3MpLFxuICAgICAgICAgICAgZGF0YS5xdWVyeU1hdGNoRXhwcnMubGVuZ3RoID8gby5saXRlcmFsQXJyKGRhdGEucXVlcnlNYXRjaEV4cHJzKSA6IG8uTlVMTF9FWFBSLFxuICAgICAgICAgICAgZGF0YS50b2tlbkV4cHIsIGRhdGEucHJvdmlkZXJFeHByLCBkYXRhLmRlcHNFeHByXG4gICAgICAgICAgXSlcbiAgICAgICAgfSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBfdmlzaXRQcm92aWRlck9yRGlyZWN0aXZlKHByb3ZpZGVyQXN0OiBQcm92aWRlckFzdCwgcXVlcnlNYXRjaGVzOiBRdWVyeU1hdGNoW10pOiB7XG4gICAgZmxhZ3M6IE5vZGVGbGFncyxcbiAgICB0b2tlbkV4cHI6IG8uRXhwcmVzc2lvbixcbiAgICBzb3VyY2VTcGFuOiBQYXJzZVNvdXJjZVNwYW4sXG4gICAgcXVlcnlNYXRjaEV4cHJzOiBvLkV4cHJlc3Npb25bXSxcbiAgICBwcm92aWRlckV4cHI6IG8uRXhwcmVzc2lvbixcbiAgICBkZXBzRXhwcjogby5FeHByZXNzaW9uXG4gIH0ge1xuICAgIGxldCBmbGFncyA9IE5vZGVGbGFncy5Ob25lO1xuICAgIGxldCBxdWVyeU1hdGNoRXhwcnM6IG8uRXhwcmVzc2lvbltdID0gW107XG5cbiAgICBxdWVyeU1hdGNoZXMuZm9yRWFjaCgobWF0Y2gpID0+IHtcbiAgICAgIGlmICh0b2tlblJlZmVyZW5jZShtYXRjaC52YWx1ZSkgPT09IHRva2VuUmVmZXJlbmNlKHByb3ZpZGVyQXN0LnRva2VuKSkge1xuICAgICAgICBxdWVyeU1hdGNoRXhwcnMucHVzaChcbiAgICAgICAgICAgIG8ubGl0ZXJhbEFycihbby5saXRlcmFsKG1hdGNoLnF1ZXJ5SWQpLCBvLmxpdGVyYWwoUXVlcnlWYWx1ZVR5cGUuUHJvdmlkZXIpXSkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IHtwcm92aWRlckV4cHIsIGRlcHNFeHByLCBmbGFnczogcHJvdmlkZXJGbGFncywgdG9rZW5FeHByfSA9XG4gICAgICAgIHByb3ZpZGVyRGVmKHRoaXMub3V0cHV0Q3R4LCBwcm92aWRlckFzdCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZsYWdzOiBmbGFncyB8IHByb3ZpZGVyRmxhZ3MsXG4gICAgICBxdWVyeU1hdGNoRXhwcnMsXG4gICAgICBwcm92aWRlckV4cHIsXG4gICAgICBkZXBzRXhwcixcbiAgICAgIHRva2VuRXhwcixcbiAgICAgIHNvdXJjZVNwYW46IHByb3ZpZGVyQXN0LnNvdXJjZVNwYW5cbiAgICB9O1xuICB9XG5cbiAgZ2V0TG9jYWwobmFtZTogc3RyaW5nKTogby5FeHByZXNzaW9ufG51bGwge1xuICAgIGlmIChuYW1lID09IEV2ZW50SGFuZGxlclZhcnMuZXZlbnQubmFtZSkge1xuICAgICAgcmV0dXJuIEV2ZW50SGFuZGxlclZhcnMuZXZlbnQ7XG4gICAgfVxuICAgIGxldCBjdXJyVmlld0V4cHI6IG8uRXhwcmVzc2lvbiA9IFZJRVdfVkFSO1xuICAgIGZvciAobGV0IGN1cnJCdWlsZGVyOiBWaWV3QnVpbGRlcnxudWxsID0gdGhpczsgY3VyckJ1aWxkZXI7IGN1cnJCdWlsZGVyID0gY3VyckJ1aWxkZXIucGFyZW50LFxuICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJyVmlld0V4cHIgPSBjdXJyVmlld0V4cHIucHJvcCgncGFyZW50JykuY2FzdChvLkRZTkFNSUNfVFlQRSkpIHtcbiAgICAgIC8vIGNoZWNrIHJlZmVyZW5jZXNcbiAgICAgIGNvbnN0IHJlZk5vZGVJbmRleCA9IGN1cnJCdWlsZGVyLnJlZk5vZGVJbmRpY2VzW25hbWVdO1xuICAgICAgaWYgKHJlZk5vZGVJbmRleCAhPSBudWxsKSB7XG4gICAgICAgIHJldHVybiBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMubm9kZVZhbHVlKS5jYWxsRm4oW2N1cnJWaWV3RXhwciwgby5saXRlcmFsKHJlZk5vZGVJbmRleCldKTtcbiAgICAgIH1cblxuICAgICAgLy8gY2hlY2sgdmFyaWFibGVzXG4gICAgICBjb25zdCB2YXJBc3QgPSBjdXJyQnVpbGRlci52YXJpYWJsZXMuZmluZCgodmFyQXN0KSA9PiB2YXJBc3QubmFtZSA9PT0gbmFtZSk7XG4gICAgICBpZiAodmFyQXN0KSB7XG4gICAgICAgIGNvbnN0IHZhclZhbHVlID0gdmFyQXN0LnZhbHVlIHx8IElNUExJQ0lUX1RFTVBMQVRFX1ZBUjtcbiAgICAgICAgcmV0dXJuIGN1cnJWaWV3RXhwci5wcm9wKCdjb250ZXh0JykucHJvcCh2YXJWYWx1ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcHJpdmF0ZSBfY3JlYXRlTGl0ZXJhbEFycmF5Q29udmVydGVyKHNvdXJjZVNwYW46IFBhcnNlU291cmNlU3BhbiwgYXJnQ291bnQ6IG51bWJlcik6XG4gICAgICBCdWlsdGluQ29udmVydGVyIHtcbiAgICBpZiAoYXJnQ291bnQgPT09IDApIHtcbiAgICAgIGNvbnN0IHZhbHVlRXhwciA9IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5FTVBUWV9BUlJBWSk7XG4gICAgICByZXR1cm4gKCkgPT4gdmFsdWVFeHByO1xuICAgIH1cblxuICAgIGNvbnN0IGNoZWNrSW5kZXggPSB0aGlzLm5vZGVzLmxlbmd0aDtcblxuICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZVNwYW4sXG4gICAgICAgICAgICAgICAgICAgICAgbm9kZUZsYWdzOiBOb2RlRmxhZ3MuVHlwZVB1cmVBcnJheSxcbiAgICAgICAgICAgICAgICAgICAgICBub2RlRGVmOiBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMucHVyZUFycmF5RGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGNoZWNrSW5kZXgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGFyZ0NvdW50KSxcbiAgICAgICAgICAgICAgICAgICAgICBdKVxuICAgICAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICByZXR1cm4gKGFyZ3M6IG8uRXhwcmVzc2lvbltdKSA9PiBjYWxsQ2hlY2tTdG10KGNoZWNrSW5kZXgsIGFyZ3MpO1xuICB9XG5cbiAgcHJpdmF0ZSBfY3JlYXRlTGl0ZXJhbE1hcENvbnZlcnRlcihcbiAgICAgIHNvdXJjZVNwYW46IFBhcnNlU291cmNlU3Bhbiwga2V5czoge2tleTogc3RyaW5nLCBxdW90ZWQ6IGJvb2xlYW59W10pOiBCdWlsdGluQ29udmVydGVyIHtcbiAgICBpZiAoa2V5cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IHZhbHVlRXhwciA9IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5FTVBUWV9NQVApO1xuICAgICAgcmV0dXJuICgpID0+IHZhbHVlRXhwcjtcbiAgICB9XG5cbiAgICBjb25zdCBtYXAgPSBvLmxpdGVyYWxNYXAoa2V5cy5tYXAoKGUsIGkpID0+ICh7Li4uZSwgdmFsdWU6IG8ubGl0ZXJhbChpKX0pKSk7XG4gICAgY29uc3QgY2hlY2tJbmRleCA9IHRoaXMubm9kZXMubGVuZ3RoO1xuICAgIHRoaXMubm9kZXMucHVzaCgoKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZVNwYW4sXG4gICAgICAgICAgICAgICAgICAgICAgbm9kZUZsYWdzOiBOb2RlRmxhZ3MuVHlwZVB1cmVPYmplY3QsXG4gICAgICAgICAgICAgICAgICAgICAgbm9kZURlZjogby5pbXBvcnRFeHByKElkZW50aWZpZXJzLnB1cmVPYmplY3REZWYpLmNhbGxGbihbXG4gICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwoY2hlY2tJbmRleCksXG4gICAgICAgICAgICAgICAgICAgICAgICBtYXAsXG4gICAgICAgICAgICAgICAgICAgICAgXSlcbiAgICAgICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgcmV0dXJuIChhcmdzOiBvLkV4cHJlc3Npb25bXSkgPT4gY2FsbENoZWNrU3RtdChjaGVja0luZGV4LCBhcmdzKTtcbiAgfVxuXG4gIHByaXZhdGUgX2NyZWF0ZVBpcGVDb252ZXJ0ZXIoZXhwcmVzc2lvbjogVXBkYXRlRXhwcmVzc2lvbiwgbmFtZTogc3RyaW5nLCBhcmdDb3VudDogbnVtYmVyKTpcbiAgICAgIEJ1aWx0aW5Db252ZXJ0ZXIge1xuICAgIGNvbnN0IHBpcGUgPSB0aGlzLnVzZWRQaXBlcy5maW5kKChwaXBlU3VtbWFyeSkgPT4gcGlwZVN1bW1hcnkubmFtZSA9PT0gbmFtZSkgITtcbiAgICBpZiAocGlwZS5wdXJlKSB7XG4gICAgICBjb25zdCBjaGVja0luZGV4ID0gdGhpcy5ub2Rlcy5sZW5ndGg7XG4gICAgICB0aGlzLm5vZGVzLnB1c2goKCkgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZVNwYW46IGV4cHJlc3Npb24uc291cmNlU3BhbixcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVGbGFnczogTm9kZUZsYWdzLlR5cGVQdXJlUGlwZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5wdXJlUGlwZURlZikuY2FsbEZuKFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsKGNoZWNrSW5kZXgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwoYXJnQ291bnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgXSlcbiAgICAgICAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICAgIC8vIGZpbmQgdW5kZXJseWluZyBwaXBlIGluIHRoZSBjb21wb25lbnQgdmlld1xuICAgICAgbGV0IGNvbXBWaWV3RXhwcjogby5FeHByZXNzaW9uID0gVklFV19WQVI7XG4gICAgICBsZXQgY29tcEJ1aWxkZXI6IFZpZXdCdWlsZGVyID0gdGhpcztcbiAgICAgIHdoaWxlIChjb21wQnVpbGRlci5wYXJlbnQpIHtcbiAgICAgICAgY29tcEJ1aWxkZXIgPSBjb21wQnVpbGRlci5wYXJlbnQ7XG4gICAgICAgIGNvbXBWaWV3RXhwciA9IGNvbXBWaWV3RXhwci5wcm9wKCdwYXJlbnQnKS5jYXN0KG8uRFlOQU1JQ19UWVBFKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBpcGVOb2RlSW5kZXggPSBjb21wQnVpbGRlci5wdXJlUGlwZU5vZGVJbmRpY2VzW25hbWVdO1xuICAgICAgY29uc3QgcGlwZVZhbHVlRXhwcjogby5FeHByZXNzaW9uID1cbiAgICAgICAgICBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMubm9kZVZhbHVlKS5jYWxsRm4oW2NvbXBWaWV3RXhwciwgby5saXRlcmFsKHBpcGVOb2RlSW5kZXgpXSk7XG5cbiAgICAgIHJldHVybiAoYXJnczogby5FeHByZXNzaW9uW10pID0+IGNhbGxVbndyYXBWYWx1ZShcbiAgICAgICAgICAgICAgICAgZXhwcmVzc2lvbi5ub2RlSW5kZXgsIGV4cHJlc3Npb24uYmluZGluZ0luZGV4LFxuICAgICAgICAgICAgICAgICBjYWxsQ2hlY2tTdG10KGNoZWNrSW5kZXgsIFtwaXBlVmFsdWVFeHByXS5jb25jYXQoYXJncykpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgbm9kZUluZGV4ID0gdGhpcy5fY3JlYXRlUGlwZShleHByZXNzaW9uLnNvdXJjZVNwYW4sIHBpcGUpO1xuICAgICAgY29uc3Qgbm9kZVZhbHVlRXhwciA9XG4gICAgICAgICAgby5pbXBvcnRFeHByKElkZW50aWZpZXJzLm5vZGVWYWx1ZSkuY2FsbEZuKFtWSUVXX1ZBUiwgby5saXRlcmFsKG5vZGVJbmRleCldKTtcblxuICAgICAgcmV0dXJuIChhcmdzOiBvLkV4cHJlc3Npb25bXSkgPT4gY2FsbFVud3JhcFZhbHVlKFxuICAgICAgICAgICAgICAgICBleHByZXNzaW9uLm5vZGVJbmRleCwgZXhwcmVzc2lvbi5iaW5kaW5nSW5kZXgsXG4gICAgICAgICAgICAgICAgIG5vZGVWYWx1ZUV4cHIuY2FsbE1ldGhvZCgndHJhbnNmb3JtJywgYXJncykpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2NyZWF0ZVBpcGUoc291cmNlU3BhbjogUGFyc2VTb3VyY2VTcGFufG51bGwsIHBpcGU6IENvbXBpbGVQaXBlU3VtbWFyeSk6IG51bWJlciB7XG4gICAgY29uc3Qgbm9kZUluZGV4ID0gdGhpcy5ub2Rlcy5sZW5ndGg7XG4gICAgbGV0IGZsYWdzID0gTm9kZUZsYWdzLk5vbmU7XG4gICAgcGlwZS50eXBlLmxpZmVjeWNsZUhvb2tzLmZvckVhY2goKGxpZmVjeWNsZUhvb2spID0+IHtcbiAgICAgIC8vIGZvciBwaXBlcywgd2Ugb25seSBzdXBwb3J0IG5nT25EZXN0cm95XG4gICAgICBpZiAobGlmZWN5Y2xlSG9vayA9PT0gTGlmZWN5Y2xlSG9va3MuT25EZXN0cm95KSB7XG4gICAgICAgIGZsYWdzIHw9IGxpZmVjeWNsZUhvb2tUb05vZGVGbGFnKGxpZmVjeWNsZUhvb2spO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVwRXhwcnMgPSBwaXBlLnR5cGUuZGlEZXBzLm1hcCgoZGlEZXApID0+IGRlcERlZih0aGlzLm91dHB1dEN0eCwgZGlEZXApKTtcbiAgICAvLyBmdW5jdGlvbiBwaXBlRGVmKFxuICAgIC8vICAgZmxhZ3M6IE5vZGVGbGFncywgY3RvcjogYW55LCBkZXBzOiAoW0RlcEZsYWdzLCBhbnldIHwgYW55KVtdKTogTm9kZURlZlxuICAgIHRoaXMubm9kZXMucHVzaChcbiAgICAgICAgKCkgPT4gKHtcbiAgICAgICAgICBzb3VyY2VTcGFuLFxuICAgICAgICAgIG5vZGVGbGFnczogTm9kZUZsYWdzLlR5cGVQaXBlLFxuICAgICAgICAgIG5vZGVEZWY6IG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy5waXBlRGVmKS5jYWxsRm4oW1xuICAgICAgICAgICAgby5saXRlcmFsKGZsYWdzKSwgdGhpcy5vdXRwdXRDdHguaW1wb3J0RXhwcihwaXBlLnR5cGUucmVmZXJlbmNlKSwgby5saXRlcmFsQXJyKGRlcEV4cHJzKVxuICAgICAgICAgIF0pXG4gICAgICAgIH0pKTtcbiAgICByZXR1cm4gbm9kZUluZGV4O1xuICB9XG5cbiAgLyoqXG4gICAqIEZvciB0aGUgQVNUIGluIGBVcGRhdGVFeHByZXNzaW9uLnZhbHVlYDpcbiAgICogLSBjcmVhdGUgbm9kZXMgZm9yIHBpcGVzLCBsaXRlcmFsIGFycmF5cyBhbmQsIGxpdGVyYWwgbWFwcyxcbiAgICogLSB1cGRhdGUgdGhlIEFTVCB0byByZXBsYWNlIHBpcGVzLCBsaXRlcmFsIGFycmF5cyBhbmQsIGxpdGVyYWwgbWFwcyB3aXRoIGNhbGxzIHRvIGNoZWNrIGZuLlxuICAgKlxuICAgKiBXQVJOSU5HOiBUaGlzIG1pZ2h0IGNyZWF0ZSBuZXcgbm9kZURlZnMgKGZvciBwaXBlcyBhbmQgbGl0ZXJhbCBhcnJheXMgYW5kIGxpdGVyYWwgbWFwcykhXG4gICAqL1xuICBwcml2YXRlIF9wcmVwcm9jZXNzVXBkYXRlRXhwcmVzc2lvbihleHByZXNzaW9uOiBVcGRhdGVFeHByZXNzaW9uKTogVXBkYXRlRXhwcmVzc2lvbiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5vZGVJbmRleDogZXhwcmVzc2lvbi5ub2RlSW5kZXgsXG4gICAgICBiaW5kaW5nSW5kZXg6IGV4cHJlc3Npb24uYmluZGluZ0luZGV4LFxuICAgICAgc291cmNlU3BhbjogZXhwcmVzc2lvbi5zb3VyY2VTcGFuLFxuICAgICAgY29udGV4dDogZXhwcmVzc2lvbi5jb250ZXh0LFxuICAgICAgdmFsdWU6IGNvbnZlcnRQcm9wZXJ0eUJpbmRpbmdCdWlsdGlucyhcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjcmVhdGVMaXRlcmFsQXJyYXlDb252ZXJ0ZXI6IChhcmdDb3VudDogbnVtYmVyKSA9PiB0aGlzLl9jcmVhdGVMaXRlcmFsQXJyYXlDb252ZXJ0ZXIoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uLnNvdXJjZVNwYW4sIGFyZ0NvdW50KSxcbiAgICAgICAgICAgIGNyZWF0ZUxpdGVyYWxNYXBDb252ZXJ0ZXI6XG4gICAgICAgICAgICAgICAgKGtleXM6IHtrZXk6IHN0cmluZywgcXVvdGVkOiBib29sZWFufVtdKSA9PlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9jcmVhdGVMaXRlcmFsTWFwQ29udmVydGVyKGV4cHJlc3Npb24uc291cmNlU3Bhbiwga2V5cyksXG4gICAgICAgICAgICBjcmVhdGVQaXBlQ29udmVydGVyOiAobmFtZTogc3RyaW5nLCBhcmdDb3VudDogbnVtYmVyKSA9PlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2NyZWF0ZVBpcGVDb252ZXJ0ZXIoZXhwcmVzc2lvbiwgbmFtZSwgYXJnQ291bnQpXG4gICAgICAgICAgfSxcbiAgICAgICAgICBleHByZXNzaW9uLnZhbHVlKVxuICAgIH07XG4gIH1cblxuICBwcml2YXRlIF9jcmVhdGVOb2RlRXhwcmVzc2lvbnMoKToge1xuICAgIHVwZGF0ZVJlbmRlcmVyU3RtdHM6IG8uU3RhdGVtZW50W10sXG4gICAgdXBkYXRlRGlyZWN0aXZlc1N0bXRzOiBvLlN0YXRlbWVudFtdLFxuICAgIG5vZGVEZWZFeHByczogby5FeHByZXNzaW9uW11cbiAgfSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgbGV0IHVwZGF0ZUJpbmRpbmdDb3VudCA9IDA7XG4gICAgY29uc3QgdXBkYXRlUmVuZGVyZXJTdG10czogby5TdGF0ZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IHVwZGF0ZURpcmVjdGl2ZXNTdG10czogby5TdGF0ZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IG5vZGVEZWZFeHBycyA9IHRoaXMubm9kZXMubWFwKChmYWN0b3J5LCBub2RlSW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IHtub2RlRGVmLCBub2RlRmxhZ3MsIHVwZGF0ZURpcmVjdGl2ZXMsIHVwZGF0ZVJlbmRlcmVyLCBzb3VyY2VTcGFufSA9IGZhY3RvcnkoKTtcbiAgICAgIGlmICh1cGRhdGVSZW5kZXJlcikge1xuICAgICAgICB1cGRhdGVSZW5kZXJlclN0bXRzLnB1c2goXG4gICAgICAgICAgICAuLi5jcmVhdGVVcGRhdGVTdGF0ZW1lbnRzKG5vZGVJbmRleCwgc291cmNlU3BhbiwgdXBkYXRlUmVuZGVyZXIsIGZhbHNlKSk7XG4gICAgICB9XG4gICAgICBpZiAodXBkYXRlRGlyZWN0aXZlcykge1xuICAgICAgICB1cGRhdGVEaXJlY3RpdmVzU3RtdHMucHVzaCguLi5jcmVhdGVVcGRhdGVTdGF0ZW1lbnRzKFxuICAgICAgICAgICAgbm9kZUluZGV4LCBzb3VyY2VTcGFuLCB1cGRhdGVEaXJlY3RpdmVzLFxuICAgICAgICAgICAgKG5vZGVGbGFncyAmIChOb2RlRmxhZ3MuRG9DaGVjayB8IE5vZGVGbGFncy5PbkluaXQpKSA+IDApKTtcbiAgICAgIH1cbiAgICAgIC8vIFdlIHVzZSBhIGNvbW1hIGV4cHJlc3Npb24gdG8gY2FsbCB0aGUgbG9nIGZ1bmN0aW9uIGJlZm9yZVxuICAgICAgLy8gdGhlIG5vZGVEZWYgZnVuY3Rpb24sIGJ1dCBzdGlsbCB1c2UgdGhlIHJlc3VsdCBvZiB0aGUgbm9kZURlZiBmdW5jdGlvblxuICAgICAgLy8gYXMgdGhlIHZhbHVlLlxuICAgICAgLy8gTm90ZTogV2Ugb25seSBhZGQgdGhlIGxvZ2dlciB0byBlbGVtZW50cyAvIHRleHQgbm9kZXMsXG4gICAgICAvLyBzbyB3ZSBkb24ndCBnZW5lcmF0ZSB0b28gbXVjaCBjb2RlLlxuICAgICAgY29uc3QgbG9nV2l0aE5vZGVEZWYgPSBub2RlRmxhZ3MgJiBOb2RlRmxhZ3MuQ2F0UmVuZGVyTm9kZSA/XG4gICAgICAgICAgbmV3IG8uQ29tbWFFeHByKFtMT0dfVkFSLmNhbGxGbihbXSkuY2FsbEZuKFtdKSwgbm9kZURlZl0pIDpcbiAgICAgICAgICBub2RlRGVmO1xuICAgICAgcmV0dXJuIG8uYXBwbHlTb3VyY2VTcGFuVG9FeHByZXNzaW9uSWZOZWVkZWQobG9nV2l0aE5vZGVEZWYsIHNvdXJjZVNwYW4pO1xuICAgIH0pO1xuICAgIHJldHVybiB7dXBkYXRlUmVuZGVyZXJTdG10cywgdXBkYXRlRGlyZWN0aXZlc1N0bXRzLCBub2RlRGVmRXhwcnN9O1xuXG4gICAgZnVuY3Rpb24gY3JlYXRlVXBkYXRlU3RhdGVtZW50cyhcbiAgICAgICAgbm9kZUluZGV4OiBudW1iZXIsIHNvdXJjZVNwYW46IFBhcnNlU291cmNlU3BhbiB8IG51bGwsIGV4cHJlc3Npb25zOiBVcGRhdGVFeHByZXNzaW9uW10sXG4gICAgICAgIGFsbG93RW1wdHlFeHByczogYm9vbGVhbik6IG8uU3RhdGVtZW50W10ge1xuICAgICAgY29uc3QgdXBkYXRlU3RtdHM6IG8uU3RhdGVtZW50W10gPSBbXTtcbiAgICAgIGNvbnN0IGV4cHJzID0gZXhwcmVzc2lvbnMubWFwKCh7c291cmNlU3BhbiwgY29udGV4dCwgdmFsdWV9KSA9PiB7XG4gICAgICAgIGNvbnN0IGJpbmRpbmdJZCA9IGAke3VwZGF0ZUJpbmRpbmdDb3VudCsrfWA7XG4gICAgICAgIGNvbnN0IG5hbWVSZXNvbHZlciA9IGNvbnRleHQgPT09IENPTVBfVkFSID8gc2VsZiA6IG51bGw7XG4gICAgICAgIGNvbnN0IHtzdG10cywgY3VyclZhbEV4cHJ9ID1cbiAgICAgICAgICAgIGNvbnZlcnRQcm9wZXJ0eUJpbmRpbmcobmFtZVJlc29sdmVyLCBjb250ZXh0LCB2YWx1ZSwgYmluZGluZ0lkLCBCaW5kaW5nRm9ybS5HZW5lcmFsKTtcbiAgICAgICAgdXBkYXRlU3RtdHMucHVzaCguLi5zdG10cy5tYXAoXG4gICAgICAgICAgICAoc3RtdDogby5TdGF0ZW1lbnQpID0+IG8uYXBwbHlTb3VyY2VTcGFuVG9TdGF0ZW1lbnRJZk5lZWRlZChzdG10LCBzb3VyY2VTcGFuKSkpO1xuICAgICAgICByZXR1cm4gby5hcHBseVNvdXJjZVNwYW5Ub0V4cHJlc3Npb25JZk5lZWRlZChjdXJyVmFsRXhwciwgc291cmNlU3Bhbik7XG4gICAgICB9KTtcbiAgICAgIGlmIChleHByZXNzaW9ucy5sZW5ndGggfHwgYWxsb3dFbXB0eUV4cHJzKSB7XG4gICAgICAgIHVwZGF0ZVN0bXRzLnB1c2goby5hcHBseVNvdXJjZVNwYW5Ub1N0YXRlbWVudElmTmVlZGVkKFxuICAgICAgICAgICAgY2FsbENoZWNrU3RtdChub2RlSW5kZXgsIGV4cHJzKS50b1N0bXQoKSwgc291cmNlU3BhbikpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVwZGF0ZVN0bXRzO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2NyZWF0ZUVsZW1lbnRIYW5kbGVFdmVudEZuKFxuICAgICAgbm9kZUluZGV4OiBudW1iZXIsXG4gICAgICBoYW5kbGVyczoge2NvbnRleHQ6IG8uRXhwcmVzc2lvbiwgZXZlbnRBc3Q6IEJvdW5kRXZlbnRBc3QsIGRpckFzdDogRGlyZWN0aXZlQXN0fVtdKSB7XG4gICAgY29uc3QgaGFuZGxlRXZlbnRTdG10czogby5TdGF0ZW1lbnRbXSA9IFtdO1xuICAgIGxldCBoYW5kbGVFdmVudEJpbmRpbmdDb3VudCA9IDA7XG4gICAgaGFuZGxlcnMuZm9yRWFjaCgoe2NvbnRleHQsIGV2ZW50QXN0LCBkaXJBc3R9KSA9PiB7XG4gICAgICBjb25zdCBiaW5kaW5nSWQgPSBgJHtoYW5kbGVFdmVudEJpbmRpbmdDb3VudCsrfWA7XG4gICAgICBjb25zdCBuYW1lUmVzb2x2ZXIgPSBjb250ZXh0ID09PSBDT01QX1ZBUiA/IHRoaXMgOiBudWxsO1xuICAgICAgY29uc3Qge3N0bXRzLCBhbGxvd0RlZmF1bHR9ID1cbiAgICAgICAgICBjb252ZXJ0QWN0aW9uQmluZGluZyhuYW1lUmVzb2x2ZXIsIGNvbnRleHQsIGV2ZW50QXN0LmhhbmRsZXIsIGJpbmRpbmdJZCk7XG4gICAgICBjb25zdCB0cnVlU3RtdHMgPSBzdG10cztcbiAgICAgIGlmIChhbGxvd0RlZmF1bHQpIHtcbiAgICAgICAgdHJ1ZVN0bXRzLnB1c2goQUxMT1dfREVGQVVMVF9WQVIuc2V0KGFsbG93RGVmYXVsdC5hbmQoQUxMT1dfREVGQVVMVF9WQVIpKS50b1N0bXQoKSk7XG4gICAgICB9XG4gICAgICBjb25zdCB7dGFyZ2V0OiBldmVudFRhcmdldCwgbmFtZTogZXZlbnROYW1lfSA9IGVsZW1lbnRFdmVudE5hbWVBbmRUYXJnZXQoZXZlbnRBc3QsIGRpckFzdCk7XG4gICAgICBjb25zdCBmdWxsRXZlbnROYW1lID0gZWxlbWVudEV2ZW50RnVsbE5hbWUoZXZlbnRUYXJnZXQsIGV2ZW50TmFtZSk7XG4gICAgICBoYW5kbGVFdmVudFN0bXRzLnB1c2goby5hcHBseVNvdXJjZVNwYW5Ub1N0YXRlbWVudElmTmVlZGVkKFxuICAgICAgICAgIG5ldyBvLklmU3RtdChvLmxpdGVyYWwoZnVsbEV2ZW50TmFtZSkuaWRlbnRpY2FsKEVWRU5UX05BTUVfVkFSKSwgdHJ1ZVN0bXRzKSxcbiAgICAgICAgICBldmVudEFzdC5zb3VyY2VTcGFuKSk7XG4gICAgfSk7XG4gICAgbGV0IGhhbmRsZUV2ZW50Rm46IG8uRXhwcmVzc2lvbjtcbiAgICBpZiAoaGFuZGxlRXZlbnRTdG10cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBwcmVTdG10czogby5TdGF0ZW1lbnRbXSA9XG4gICAgICAgICAgW0FMTE9XX0RFRkFVTFRfVkFSLnNldChvLmxpdGVyYWwodHJ1ZSkpLnRvRGVjbFN0bXQoby5CT09MX1RZUEUpXTtcbiAgICAgIGlmICghdGhpcy5jb21wb25lbnQuaXNIb3N0ICYmIG8uZmluZFJlYWRWYXJOYW1lcyhoYW5kbGVFdmVudFN0bXRzKS5oYXMoQ09NUF9WQVIubmFtZSAhKSkge1xuICAgICAgICBwcmVTdG10cy5wdXNoKENPTVBfVkFSLnNldChWSUVXX1ZBUi5wcm9wKCdjb21wb25lbnQnKSkudG9EZWNsU3RtdCh0aGlzLmNvbXBUeXBlKSk7XG4gICAgICB9XG4gICAgICBoYW5kbGVFdmVudEZuID0gby5mbihcbiAgICAgICAgICBbXG4gICAgICAgICAgICBuZXcgby5GblBhcmFtKFZJRVdfVkFSLm5hbWUgISwgby5JTkZFUlJFRF9UWVBFKSxcbiAgICAgICAgICAgIG5ldyBvLkZuUGFyYW0oRVZFTlRfTkFNRV9WQVIubmFtZSAhLCBvLklORkVSUkVEX1RZUEUpLFxuICAgICAgICAgICAgbmV3IG8uRm5QYXJhbShFdmVudEhhbmRsZXJWYXJzLmV2ZW50Lm5hbWUgISwgby5JTkZFUlJFRF9UWVBFKVxuICAgICAgICAgIF0sXG4gICAgICAgICAgWy4uLnByZVN0bXRzLCAuLi5oYW5kbGVFdmVudFN0bXRzLCBuZXcgby5SZXR1cm5TdGF0ZW1lbnQoQUxMT1dfREVGQVVMVF9WQVIpXSxcbiAgICAgICAgICBvLklORkVSUkVEX1RZUEUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBoYW5kbGVFdmVudEZuID0gby5OVUxMX0VYUFI7XG4gICAgfVxuICAgIHJldHVybiBoYW5kbGVFdmVudEZuO1xuICB9XG5cbiAgdmlzaXREaXJlY3RpdmUoYXN0OiBEaXJlY3RpdmVBc3QsIGNvbnRleHQ6IHt1c2VkRXZlbnRzOiBTZXQ8c3RyaW5nPn0pOiBhbnkge31cbiAgdmlzaXREaXJlY3RpdmVQcm9wZXJ0eShhc3Q6IEJvdW5kRGlyZWN0aXZlUHJvcGVydHlBc3QsIGNvbnRleHQ6IGFueSk6IGFueSB7fVxuICB2aXNpdFJlZmVyZW5jZShhc3Q6IFJlZmVyZW5jZUFzdCwgY29udGV4dDogYW55KTogYW55IHt9XG4gIHZpc2l0VmFyaWFibGUoYXN0OiBWYXJpYWJsZUFzdCwgY29udGV4dDogYW55KTogYW55IHt9XG4gIHZpc2l0RXZlbnQoYXN0OiBCb3VuZEV2ZW50QXN0LCBjb250ZXh0OiBhbnkpOiBhbnkge31cbiAgdmlzaXRFbGVtZW50UHJvcGVydHkoYXN0OiBCb3VuZEVsZW1lbnRQcm9wZXJ0eUFzdCwgY29udGV4dDogYW55KTogYW55IHt9XG4gIHZpc2l0QXR0cihhc3Q6IEF0dHJBc3QsIGNvbnRleHQ6IGFueSk6IGFueSB7fVxufVxuXG5mdW5jdGlvbiBuZWVkc0FkZGl0aW9uYWxSb290Tm9kZShhc3ROb2RlczogVGVtcGxhdGVBc3RbXSk6IGJvb2xlYW4ge1xuICBjb25zdCBsYXN0QXN0Tm9kZSA9IGFzdE5vZGVzW2FzdE5vZGVzLmxlbmd0aCAtIDFdO1xuICBpZiAobGFzdEFzdE5vZGUgaW5zdGFuY2VvZiBFbWJlZGRlZFRlbXBsYXRlQXN0KSB7XG4gICAgcmV0dXJuIGxhc3RBc3ROb2RlLmhhc1ZpZXdDb250YWluZXI7XG4gIH1cblxuICBpZiAobGFzdEFzdE5vZGUgaW5zdGFuY2VvZiBFbGVtZW50QXN0KSB7XG4gICAgaWYgKGlzTmdDb250YWluZXIobGFzdEFzdE5vZGUubmFtZSkgJiYgbGFzdEFzdE5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gbmVlZHNBZGRpdGlvbmFsUm9vdE5vZGUobGFzdEFzdE5vZGUuY2hpbGRyZW4pO1xuICAgIH1cbiAgICByZXR1cm4gbGFzdEFzdE5vZGUuaGFzVmlld0NvbnRhaW5lcjtcbiAgfVxuXG4gIHJldHVybiBsYXN0QXN0Tm9kZSBpbnN0YW5jZW9mIE5nQ29udGVudEFzdDtcbn1cblxuXG5mdW5jdGlvbiBlbGVtZW50QmluZGluZ0RlZihpbnB1dEFzdDogQm91bmRFbGVtZW50UHJvcGVydHlBc3QsIGRpckFzdDogRGlyZWN0aXZlQXN0KTogby5FeHByZXNzaW9uIHtcbiAgY29uc3QgaW5wdXRUeXBlID0gaW5wdXRBc3QudHlwZTtcbiAgc3dpdGNoIChpbnB1dFR5cGUpIHtcbiAgICBjYXNlIFByb3BlcnR5QmluZGluZ1R5cGUuQXR0cmlidXRlOlxuICAgICAgcmV0dXJuIG8ubGl0ZXJhbEFycihbXG4gICAgICAgIG8ubGl0ZXJhbChCaW5kaW5nRmxhZ3MuVHlwZUVsZW1lbnRBdHRyaWJ1dGUpLCBvLmxpdGVyYWwoaW5wdXRBc3QubmFtZSksXG4gICAgICAgIG8ubGl0ZXJhbChpbnB1dEFzdC5zZWN1cml0eUNvbnRleHQpXG4gICAgICBdKTtcbiAgICBjYXNlIFByb3BlcnR5QmluZGluZ1R5cGUuUHJvcGVydHk6XG4gICAgICByZXR1cm4gby5saXRlcmFsQXJyKFtcbiAgICAgICAgby5saXRlcmFsKEJpbmRpbmdGbGFncy5UeXBlUHJvcGVydHkpLCBvLmxpdGVyYWwoaW5wdXRBc3QubmFtZSksXG4gICAgICAgIG8ubGl0ZXJhbChpbnB1dEFzdC5zZWN1cml0eUNvbnRleHQpXG4gICAgICBdKTtcbiAgICBjYXNlIFByb3BlcnR5QmluZGluZ1R5cGUuQW5pbWF0aW9uOlxuICAgICAgY29uc3QgYmluZGluZ1R5cGUgPSBCaW5kaW5nRmxhZ3MuVHlwZVByb3BlcnR5IHxcbiAgICAgICAgICAoZGlyQXN0ICYmIGRpckFzdC5kaXJlY3RpdmUuaXNDb21wb25lbnQgPyBCaW5kaW5nRmxhZ3MuU3ludGhldGljSG9zdFByb3BlcnR5IDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBCaW5kaW5nRmxhZ3MuU3ludGhldGljUHJvcGVydHkpO1xuICAgICAgcmV0dXJuIG8ubGl0ZXJhbEFycihbXG4gICAgICAgIG8ubGl0ZXJhbChiaW5kaW5nVHlwZSksIG8ubGl0ZXJhbCgnQCcgKyBpbnB1dEFzdC5uYW1lKSwgby5saXRlcmFsKGlucHV0QXN0LnNlY3VyaXR5Q29udGV4dClcbiAgICAgIF0pO1xuICAgIGNhc2UgUHJvcGVydHlCaW5kaW5nVHlwZS5DbGFzczpcbiAgICAgIHJldHVybiBvLmxpdGVyYWxBcnIoXG4gICAgICAgICAgW28ubGl0ZXJhbChCaW5kaW5nRmxhZ3MuVHlwZUVsZW1lbnRDbGFzcyksIG8ubGl0ZXJhbChpbnB1dEFzdC5uYW1lKSwgby5OVUxMX0VYUFJdKTtcbiAgICBjYXNlIFByb3BlcnR5QmluZGluZ1R5cGUuU3R5bGU6XG4gICAgICByZXR1cm4gby5saXRlcmFsQXJyKFtcbiAgICAgICAgby5saXRlcmFsKEJpbmRpbmdGbGFncy5UeXBlRWxlbWVudFN0eWxlKSwgby5saXRlcmFsKGlucHV0QXN0Lm5hbWUpLCBvLmxpdGVyYWwoaW5wdXRBc3QudW5pdClcbiAgICAgIF0pO1xuICAgIGRlZmF1bHQ6XG4gICAgICAvLyBUaGlzIGRlZmF1bHQgY2FzZSBpcyBub3QgbmVlZGVkIGJ5IFR5cGVTY3JpcHQgY29tcGlsZXIsIGFzIHRoZSBzd2l0Y2ggaXMgZXhoYXVzdGl2ZS5cbiAgICAgIC8vIEhvd2V2ZXIgQ2xvc3VyZSBDb21waWxlciBkb2VzIG5vdCB1bmRlcnN0YW5kIHRoYXQgYW5kIHJlcG9ydHMgYW4gZXJyb3IgaW4gdHlwZWQgbW9kZS5cbiAgICAgIC8vIFRoZSBgdGhyb3cgbmV3IEVycm9yYCBiZWxvdyB3b3JrcyBhcm91bmQgdGhlIHByb2JsZW0sIGFuZCB0aGUgdW5leHBlY3RlZDogbmV2ZXIgdmFyaWFibGVcbiAgICAgIC8vIG1ha2VzIHN1cmUgdHNjIHN0aWxsIGNoZWNrcyB0aGlzIGNvZGUgaXMgdW5yZWFjaGFibGUuXG4gICAgICBjb25zdCB1bmV4cGVjdGVkOiBuZXZlciA9IGlucHV0VHlwZTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgdW5leHBlY3RlZCAke3VuZXhwZWN0ZWR9YCk7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBmaXhlZEF0dHJzRGVmKGVsZW1lbnRBc3Q6IEVsZW1lbnRBc3QpOiBvLkV4cHJlc3Npb24ge1xuICBjb25zdCBtYXBSZXN1bHQ6IHtba2V5OiBzdHJpbmddOiBzdHJpbmd9ID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgZWxlbWVudEFzdC5hdHRycy5mb3JFYWNoKGF0dHJBc3QgPT4geyBtYXBSZXN1bHRbYXR0ckFzdC5uYW1lXSA9IGF0dHJBc3QudmFsdWU7IH0pO1xuICBlbGVtZW50QXN0LmRpcmVjdGl2ZXMuZm9yRWFjaChkaXJBc3QgPT4ge1xuICAgIE9iamVjdC5rZXlzKGRpckFzdC5kaXJlY3RpdmUuaG9zdEF0dHJpYnV0ZXMpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGRpckFzdC5kaXJlY3RpdmUuaG9zdEF0dHJpYnV0ZXNbbmFtZV07XG4gICAgICBjb25zdCBwcmV2VmFsdWUgPSBtYXBSZXN1bHRbbmFtZV07XG4gICAgICBtYXBSZXN1bHRbbmFtZV0gPSBwcmV2VmFsdWUgIT0gbnVsbCA/IG1lcmdlQXR0cmlidXRlVmFsdWUobmFtZSwgcHJldlZhbHVlLCB2YWx1ZSkgOiB2YWx1ZTtcbiAgICB9KTtcbiAgfSk7XG4gIC8vIE5vdGU6IFdlIG5lZWQgdG8gc29ydCB0byBnZXQgYSBkZWZpbmVkIG91dHB1dCBvcmRlclxuICAvLyBmb3IgdGVzdHMgYW5kIGZvciBjYWNoaW5nIGdlbmVyYXRlZCBhcnRpZmFjdHMuLi5cbiAgcmV0dXJuIG8ubGl0ZXJhbEFycihPYmplY3Qua2V5cyhtYXBSZXN1bHQpLnNvcnQoKS5tYXAoXG4gICAgICAoYXR0ck5hbWUpID0+IG8ubGl0ZXJhbEFycihbby5saXRlcmFsKGF0dHJOYW1lKSwgby5saXRlcmFsKG1hcFJlc3VsdFthdHRyTmFtZV0pXSkpKTtcbn1cblxuZnVuY3Rpb24gbWVyZ2VBdHRyaWJ1dGVWYWx1ZShhdHRyTmFtZTogc3RyaW5nLCBhdHRyVmFsdWUxOiBzdHJpbmcsIGF0dHJWYWx1ZTI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChhdHRyTmFtZSA9PSBDTEFTU19BVFRSIHx8IGF0dHJOYW1lID09IFNUWUxFX0FUVFIpIHtcbiAgICByZXR1cm4gYCR7YXR0clZhbHVlMX0gJHthdHRyVmFsdWUyfWA7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGF0dHJWYWx1ZTI7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FsbENoZWNrU3RtdChub2RlSW5kZXg6IG51bWJlciwgZXhwcnM6IG8uRXhwcmVzc2lvbltdKTogby5FeHByZXNzaW9uIHtcbiAgaWYgKGV4cHJzLmxlbmd0aCA+IDEwKSB7XG4gICAgcmV0dXJuIENIRUNLX1ZBUi5jYWxsRm4oXG4gICAgICAgIFtWSUVXX1ZBUiwgby5saXRlcmFsKG5vZGVJbmRleCksIG8ubGl0ZXJhbChBcmd1bWVudFR5cGUuRHluYW1pYyksIG8ubGl0ZXJhbEFycihleHBycyldKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gQ0hFQ0tfVkFSLmNhbGxGbihcbiAgICAgICAgW1ZJRVdfVkFSLCBvLmxpdGVyYWwobm9kZUluZGV4KSwgby5saXRlcmFsKEFyZ3VtZW50VHlwZS5JbmxpbmUpLCAuLi5leHByc10pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbGxVbndyYXBWYWx1ZShub2RlSW5kZXg6IG51bWJlciwgYmluZGluZ0lkeDogbnVtYmVyLCBleHByOiBvLkV4cHJlc3Npb24pOiBvLkV4cHJlc3Npb24ge1xuICByZXR1cm4gby5pbXBvcnRFeHByKElkZW50aWZpZXJzLnVud3JhcFZhbHVlKS5jYWxsRm4oW1xuICAgIFZJRVdfVkFSLCBvLmxpdGVyYWwobm9kZUluZGV4KSwgby5saXRlcmFsKGJpbmRpbmdJZHgpLCBleHByXG4gIF0pO1xufVxuXG5pbnRlcmZhY2UgU3RhdGljQW5kRHluYW1pY1F1ZXJ5SWRzIHtcbiAgc3RhdGljUXVlcnlJZHM6IFNldDxudW1iZXI+O1xuICBkeW5hbWljUXVlcnlJZHM6IFNldDxudW1iZXI+O1xufVxuXG5cbmZ1bmN0aW9uIGZpbmRTdGF0aWNRdWVyeUlkcyhcbiAgICBub2RlczogVGVtcGxhdGVBc3RbXSwgcmVzdWx0ID0gbmV3IE1hcDxUZW1wbGF0ZUFzdCwgU3RhdGljQW5kRHluYW1pY1F1ZXJ5SWRzPigpKTpcbiAgICBNYXA8VGVtcGxhdGVBc3QsIFN0YXRpY0FuZER5bmFtaWNRdWVyeUlkcz4ge1xuICBub2Rlcy5mb3JFYWNoKChub2RlKSA9PiB7XG4gICAgY29uc3Qgc3RhdGljUXVlcnlJZHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBjb25zdCBkeW5hbWljUXVlcnlJZHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBsZXQgcXVlcnlNYXRjaGVzOiBRdWVyeU1hdGNoW10gPSB1bmRlZmluZWQgITtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIEVsZW1lbnRBc3QpIHtcbiAgICAgIGZpbmRTdGF0aWNRdWVyeUlkcyhub2RlLmNoaWxkcmVuLCByZXN1bHQpO1xuICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4ge1xuICAgICAgICBjb25zdCBjaGlsZERhdGEgPSByZXN1bHQuZ2V0KGNoaWxkKSAhO1xuICAgICAgICBjaGlsZERhdGEuc3RhdGljUXVlcnlJZHMuZm9yRWFjaChxdWVyeUlkID0+IHN0YXRpY1F1ZXJ5SWRzLmFkZChxdWVyeUlkKSk7XG4gICAgICAgIGNoaWxkRGF0YS5keW5hbWljUXVlcnlJZHMuZm9yRWFjaChxdWVyeUlkID0+IGR5bmFtaWNRdWVyeUlkcy5hZGQocXVlcnlJZCkpO1xuICAgICAgfSk7XG4gICAgICBxdWVyeU1hdGNoZXMgPSBub2RlLnF1ZXJ5TWF0Y2hlcztcbiAgICB9IGVsc2UgaWYgKG5vZGUgaW5zdGFuY2VvZiBFbWJlZGRlZFRlbXBsYXRlQXN0KSB7XG4gICAgICBmaW5kU3RhdGljUXVlcnlJZHMobm9kZS5jaGlsZHJlbiwgcmVzdWx0KTtcbiAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHtcbiAgICAgICAgY29uc3QgY2hpbGREYXRhID0gcmVzdWx0LmdldChjaGlsZCkgITtcbiAgICAgICAgY2hpbGREYXRhLnN0YXRpY1F1ZXJ5SWRzLmZvckVhY2gocXVlcnlJZCA9PiBkeW5hbWljUXVlcnlJZHMuYWRkKHF1ZXJ5SWQpKTtcbiAgICAgICAgY2hpbGREYXRhLmR5bmFtaWNRdWVyeUlkcy5mb3JFYWNoKHF1ZXJ5SWQgPT4gZHluYW1pY1F1ZXJ5SWRzLmFkZChxdWVyeUlkKSk7XG4gICAgICB9KTtcbiAgICAgIHF1ZXJ5TWF0Y2hlcyA9IG5vZGUucXVlcnlNYXRjaGVzO1xuICAgIH1cbiAgICBpZiAocXVlcnlNYXRjaGVzKSB7XG4gICAgICBxdWVyeU1hdGNoZXMuZm9yRWFjaCgobWF0Y2gpID0+IHN0YXRpY1F1ZXJ5SWRzLmFkZChtYXRjaC5xdWVyeUlkKSk7XG4gICAgfVxuICAgIGR5bmFtaWNRdWVyeUlkcy5mb3JFYWNoKHF1ZXJ5SWQgPT4gc3RhdGljUXVlcnlJZHMuZGVsZXRlKHF1ZXJ5SWQpKTtcbiAgICByZXN1bHQuc2V0KG5vZGUsIHtzdGF0aWNRdWVyeUlkcywgZHluYW1pY1F1ZXJ5SWRzfSk7XG4gIH0pO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzdGF0aWNWaWV3UXVlcnlJZHMobm9kZVN0YXRpY1F1ZXJ5SWRzOiBNYXA8VGVtcGxhdGVBc3QsIFN0YXRpY0FuZER5bmFtaWNRdWVyeUlkcz4pOlxuICAgIFN0YXRpY0FuZER5bmFtaWNRdWVyeUlkcyB7XG4gIGNvbnN0IHN0YXRpY1F1ZXJ5SWRzID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IGR5bmFtaWNRdWVyeUlkcyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICBBcnJheS5mcm9tKG5vZGVTdGF0aWNRdWVyeUlkcy52YWx1ZXMoKSkuZm9yRWFjaCgoZW50cnkpID0+IHtcbiAgICBlbnRyeS5zdGF0aWNRdWVyeUlkcy5mb3JFYWNoKHF1ZXJ5SWQgPT4gc3RhdGljUXVlcnlJZHMuYWRkKHF1ZXJ5SWQpKTtcbiAgICBlbnRyeS5keW5hbWljUXVlcnlJZHMuZm9yRWFjaChxdWVyeUlkID0+IGR5bmFtaWNRdWVyeUlkcy5hZGQocXVlcnlJZCkpO1xuICB9KTtcbiAgZHluYW1pY1F1ZXJ5SWRzLmZvckVhY2gocXVlcnlJZCA9PiBzdGF0aWNRdWVyeUlkcy5kZWxldGUocXVlcnlJZCkpO1xuICByZXR1cm4ge3N0YXRpY1F1ZXJ5SWRzLCBkeW5hbWljUXVlcnlJZHN9O1xufVxuXG5mdW5jdGlvbiBlbGVtZW50RXZlbnROYW1lQW5kVGFyZ2V0KFxuICAgIGV2ZW50QXN0OiBCb3VuZEV2ZW50QXN0LCBkaXJBc3Q6IERpcmVjdGl2ZUFzdCB8IG51bGwpOiB7bmFtZTogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyB8IG51bGx9IHtcbiAgaWYgKGV2ZW50QXN0LmlzQW5pbWF0aW9uKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IGBAJHtldmVudEFzdC5uYW1lfS4ke2V2ZW50QXN0LnBoYXNlfWAsXG4gICAgICB0YXJnZXQ6IGRpckFzdCAmJiBkaXJBc3QuZGlyZWN0aXZlLmlzQ29tcG9uZW50ID8gJ2NvbXBvbmVudCcgOiBudWxsXG4gICAgfTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gZXZlbnRBc3Q7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FsY1N0YXRpY0R5bmFtaWNRdWVyeUZsYWdzKFxuICAgIHF1ZXJ5SWRzOiBTdGF0aWNBbmREeW5hbWljUXVlcnlJZHMsIHF1ZXJ5SWQ6IG51bWJlciwgcXVlcnk6IENvbXBpbGVRdWVyeU1ldGFkYXRhKSB7XG4gIGxldCBmbGFncyA9IE5vZGVGbGFncy5Ob25lO1xuICAvLyBOb3RlOiBXZSBvbmx5IG1ha2UgcXVlcmllcyBzdGF0aWMgdGhhdCBxdWVyeSBmb3IgYSBzaW5nbGUgaXRlbS5cbiAgLy8gVGhpcyBpcyBiZWNhdXNlIG9mIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5IHdpdGggdGhlIG9sZCB2aWV3IGNvbXBpbGVyLi4uXG4gIGlmIChxdWVyeS5maXJzdCAmJiBzaG91bGRSZXNvbHZlQXNTdGF0aWNRdWVyeShxdWVyeUlkcywgcXVlcnlJZCwgcXVlcnkpKSB7XG4gICAgZmxhZ3MgfD0gTm9kZUZsYWdzLlN0YXRpY1F1ZXJ5O1xuICB9IGVsc2Uge1xuICAgIGZsYWdzIHw9IE5vZGVGbGFncy5EeW5hbWljUXVlcnk7XG4gIH1cbiAgcmV0dXJuIGZsYWdzO1xufVxuXG5mdW5jdGlvbiBzaG91bGRSZXNvbHZlQXNTdGF0aWNRdWVyeShcbiAgICBxdWVyeUlkczogU3RhdGljQW5kRHluYW1pY1F1ZXJ5SWRzLCBxdWVyeUlkOiBudW1iZXIsIHF1ZXJ5OiBDb21waWxlUXVlcnlNZXRhZGF0YSk6IGJvb2xlYW4ge1xuICAvLyBJZiBxdWVyeS5zdGF0aWMgaGFzIGJlZW4gc2V0IGJ5IHRoZSB1c2VyLCB1c2UgdGhhdCB2YWx1ZSB0byBkZXRlcm1pbmUgd2hldGhlclxuICAvLyB0aGUgcXVlcnkgaXMgc3RhdGljLiBJZiBub25lIGhhcyBiZWVuIHNldCwgc29ydCB0aGUgcXVlcnkgaW50byBzdGF0aWMvZHluYW1pY1xuICAvLyBiYXNlZCBvbiBxdWVyeSByZXN1bHRzIChpLmUuIGR5bmFtaWMgaWYgQ0QgbmVlZHMgdG8gcnVuIHRvIGdldCBhbGwgcmVzdWx0cykuXG4gIHJldHVybiBxdWVyeS5zdGF0aWMgfHxcbiAgICAgIHF1ZXJ5LnN0YXRpYyA9PSBudWxsICYmXG4gICAgICAocXVlcnlJZHMuc3RhdGljUXVlcnlJZHMuaGFzKHF1ZXJ5SWQpIHx8ICFxdWVyeUlkcy5keW5hbWljUXVlcnlJZHMuaGFzKHF1ZXJ5SWQpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVsZW1lbnRFdmVudEZ1bGxOYW1lKHRhcmdldDogc3RyaW5nIHwgbnVsbCwgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRhcmdldCA/IGAke3RhcmdldH06JHtuYW1lfWAgOiBuYW1lO1xufVxuIl19