import DeckGL, { MapController } from 'deck.gl'
import * as React from 'react'
import { FlyToInterpolator, StaticMap, ViewportProps, ViewState, ViewStateChangeInfo } from 'react-map-gl'
import FlowMapLayer, { FlowLayerPickingInfo, LocationTotalsLegend, PickingType } from 'flowmap.gl'
import WebMercatorViewport from 'viewport-mercator-project'
import { createSelector } from 'reselect'
import { colors } from './colors'
import { fitLocationsInView, getInitialViewState } from './fitInView'
import withFetchSheets, { Message } from './withFetchGoogleSheet'
import { Absolute, Box, Column, LegendTitle, Title, TitleBox, WarningBox, WarningTitle } from './Boxes'
import Logo from './Logo';
import { findDOMNode } from 'react-dom';
import { FlowTooltipContent, LocationTooltipContent } from './TooltipContent';
import Tooltip, { Props as TooltipProps, TargetBounds } from './Tooltip';
import { Link } from 'react-router-dom';
import Collapsible, { Direction } from './Collapsible';
import { NoScrollContainer } from './App';

const DEFAULT_MAPBOX_TOKEN = process.env.REACT_APP_MapboxAccessToken
const CONTROLLER_OPTIONS = {
  type: MapController,
  dragRotate: false,
  touchRotate: false,
}

export interface ConfigProp {
  property: string
  value: string
}

enum ConfigPropName {
  TITLE = 'title',
  DESCRIPTION = 'description',
  SOURCE_NAME = 'source.name',
  SOURCE_URL = 'source.url',
  MAPBOX_ACCESS_TOKEN = 'mapbox.accessToken',
}

export interface Location {
  id: string
  lon: string
  lat: string
  name: string
}

export interface Flow {
  origin: string
  dest: string
  count: string
}


type Props = {
  properties: ConfigProp[] | null
  locations: Location[] | null
  flows: Flow[] | null
  spreadSheetKey: string
}

enum HighlightType {
  LOCATION = 'location',
  FLOW = 'flow',
}

interface LocationHighlight {
  type: HighlightType.LOCATION;
  locationId: string;
}

interface FlowHighlight {
  type: HighlightType.FLOW;
  flow: Flow;
}

type Highlight = LocationHighlight | FlowHighlight;

type State = {
  viewState: ViewState | ViewportProps
  lastLocations: Location[] | undefined
  tooltip?: TooltipProps
  highlight?: Highlight
  selectedLocationIds?: string[]
  error?: string
}

export const getFlowMagnitude = (flow: Flow) => +flow.count
const getFlowOriginId = (flow: Flow) => flow.origin
const getFlowDestId = (flow: Flow) => flow.dest
const getLocationId = (loc: Location) => loc.id
const getLocationCentroid = (location: Location): [number, number] => [+location.lon, +location.lat]

const initialViewState = getInitialViewState([ -180, -70, 180, 70 ]);

class FlowMap extends React.Component<Props, State> {
  readonly state: State = {
    viewState: initialViewState,
    lastLocations: undefined,
    error: undefined,
  }

  private flowMapLayer: FlowMapLayer | undefined = undefined

  getFlows = (props: Props) => props.flows
  getLocations = (props: Props) => props.locations

  getConfigPropValue = (name: ConfigPropName) => {
    const { properties } = this.props
    if (!properties) return undefined
    const found = properties.find(prop => prop.property === name)
    return found ? found.value : undefined
  }

  getKnownLocationIds = createSelector(
    this.getLocations,
    locations => locations ? new Set(locations.map(getLocationId)) : undefined
  )

  getFlowsForKnownLocations = createSelector(
    this.getFlows,
    this.getKnownLocationIds,
    (flows, ids) => {
      if (!ids || !flows) return undefined
      return flows.filter(flow =>
        ids.has(getFlowOriginId(flow)) &&
        ids.has(getFlowDestId(flow))
      )
    }
  )

  getUnknownLocations = createSelector(
    this.getKnownLocationIds,
    this.getFlows,
    this.getFlowsForKnownLocations,
    (ids, flows, flowsForKnownLocations) => {
      if (!ids || !flows || !flowsForKnownLocations) return undefined
      if (flows.length === flowsForKnownLocations.length) return undefined
      const missing = new Set()
      for (const flow of flows) {
        if (!ids.has(getFlowOriginId(flow))) missing.add(getFlowOriginId(flow))
        if (!ids.has(getFlowDestId(flow))) missing.add(getFlowDestId(flow))
      }
      return missing
    }
  )

  getLayers() {
    const { locations } = this.props
    const { highlight, selectedLocationIds } = this.state;
    const flows = this.getFlowsForKnownLocations(this.props)
    const layers = []
    if (locations && flows) {
      layers.push(
        this.flowMapLayer = new FlowMapLayer({
          id: 'flow-map-layer',
          colors,
          locations,
          flows,
          getLocationCentroid,
          getFlowMagnitude,
          getFlowOriginId,
          getFlowDestId,
          getLocationId,
          varyFlowColorByMagnitude: true,
          showTotals: true,
          selectedLocationIds,
          highlightedLocationId: highlight && highlight.type === HighlightType.LOCATION ? highlight.locationId : undefined,
          highlightedFlow: highlight && highlight.type === HighlightType.FLOW ? highlight.flow : undefined,
          onHover: this.handleHover,
          onClick: this.handleClick,
        }),
      )
    }
    return layers
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const { locations } = props
    if (locations != null && locations !== state.lastLocations) {
      const viewState = fitLocationsInView(
        locations,
        getLocationCentroid,
        [
          window.innerWidth,
          window.innerHeight,
        ],
        { pad: 0.05 }
      )
      if (!viewState.zoom) {
        return {
          error: `The geo bounding box couldn't be calculated. 
          Please, make sure that all the locations have valid coordinates in the spreadsheet.`
        }
      }
      return {
        lastLocations: locations,
        viewState: {
          ...viewState,
          minPitch: 0,
          maxPitch: 0,
          bearing: 0,
          pitch: 0,
          // transitionDuration: 2000,
          // transitionInterpolator: new FlyToInterpolator(),
          // transitionEasing: d3ease.easeCubic,
        }
      }
    }

    return null
  }

  getContainerClientRect = () => {
    const container = findDOMNode(this) as Element
    if (!container) return undefined
    return container.getBoundingClientRect()
  }

  getMercator = () => {
    const containerBounds = this.getContainerClientRect()
    if (!containerBounds) return undefined
    const { width, height } = containerBounds
    return new WebMercatorViewport({
      ...this.state.viewState,
      width, height,
    })
  }

  componentDidMount() {
    document.addEventListener('keydown', this.handleKeyDown)
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.handleKeyDown)
  }

  hideTooltip = () => {
    this.setState({
      tooltip: undefined
    })
  }

  showFlowTooltip = (pos: [number, number], flow: Flow) => {
    const [x, y] = pos
    const { flowMapLayer } = this
    if (!flowMapLayer) return
    // TODO: add it to PickingInfo in flowmap.gl
    const getLocationById = flowMapLayer.state.selectors.getLocationByIdGetter(flowMapLayer.props)
    const origin = getLocationById(flow.origin)
    const dest = getLocationById(flow.dest)
    const r = 5
    this.showTooltip(
      {
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
      },
      <FlowTooltipContent
        flow={flow}
        origin={origin}
        dest={dest}
      />
    )
  }

  showLocationTooltip = (location: Location) => {
    const mercator = this.getMercator()
    if (!mercator) return
    const [x, y] = mercator.project(getLocationCentroid(location))
    const { flowMapLayer } = this
    if (!flowMapLayer) return
      // TODO: add the circle bounds to PickingInfo in flowmap.gl
    const getRadius = flowMapLayer.state.selectors.getLocationCircleRadiusGetter(flowMapLayer.props)
    const r = getRadius({ location, type: 'inner' }) + 5
    this.showTooltip(
      {
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
      },
      <LocationTooltipContent location={location} />
    )
  }

  showTooltip = (bounds: TargetBounds, content: React.ReactNode) => {
    const containerBounds = this.getContainerClientRect()
    if (!containerBounds) return
    const { top, left } = containerBounds
    this.setState({
      tooltip: {
        target: {
          ...bounds,
          left: left + bounds.left,
          top: top + bounds.top,
        },
        placement: 'top',
        content,
      }
    })
  }

  handleViewStateChange = ({ viewState }: ViewStateChangeInfo) => {
    this.setState({
      viewState,
      tooltip: undefined,
      highlight: undefined,
    })
  }

  private highlight(highlight: Highlight | undefined) {
    this.setState({ highlight });
  }

  private handleHover = ({ type, object, x, y }: FlowLayerPickingInfo) => {
    switch (type) {
      case PickingType.FLOW: {
        if (object) {
          this.highlight({
            type: HighlightType.FLOW,
            flow: object,
          })
          this.showFlowTooltip(
            [x, y],
            object as Flow
          )
        } else {
          this.highlight(undefined);
          this.hideTooltip()
        }
        break
      }
      case PickingType.LOCATION: {
        if (object) {
          this.highlight({
            type: HighlightType.LOCATION,
            locationId: getLocationId!(object),
          })
          this.showLocationTooltip(object as Location)
        } else {
          this.highlight(undefined);
          this.hideTooltip()
        }
        break
      }
      default: {
        this.highlight(undefined)
        this.hideTooltip()
      }
    }
  };

  private handleClick = ({ type, object }: FlowLayerPickingInfo) => {
    switch (type) {
      case PickingType.LOCATION:
      // fall through
      case PickingType.LOCATION_AREA: {
        if (object) {
          this.setState(state => {
            const { selectedLocationIds } = state
            const locationId = getLocationId!(object)
            return {
              ...state,
              ...(selectedLocationIds && selectedLocationIds.indexOf(locationId) >= 0 ? {
                selectedLocationIds: undefined,
                highlight: undefined,
              }: {
                selectedLocationIds: [locationId],
              }),
              tooltip: undefined,
            }
          })
        }
        break
      }
    }
  };

  private handleKeyDown = (evt: Event) => {
    if (evt instanceof KeyboardEvent && evt.key === 'Escape') {
      this.setState({
        selectedLocationIds: undefined,
        highlight: undefined,
        tooltip: undefined,
      })
    }
  }

  static getDerivedStateFromError(error: any) {
    return { error: error.toString() }
  }

  render() {
    const { properties, spreadSheetKey } = this.props
    // if (!properties) {
    //   // we need to wait to get mapboxAccessToken
    //   return <Absolute top={10} left={10}>Loading…</Absolute>
    // }
    const { viewState, tooltip, error } = this.state
    if (error)  {
      return <Message>Oops… There is a problem. <br/>{error}</Message>
    }
    const unknownLocations = this.getUnknownLocations(this.props);
    const flows = this.getFlowsForKnownLocations(this.props)
    const allFlows = this.props.flows
    const title = this.getConfigPropValue(ConfigPropName.TITLE)
    const description = this.getConfigPropValue(ConfigPropName.DESCRIPTION)
    const sourceUrl = this.getConfigPropValue(ConfigPropName.SOURCE_URL);
    const sourceName = this.getConfigPropValue(ConfigPropName.SOURCE_NAME);
    const mapboxAccessToken =
      properties &&
      (this.getConfigPropValue(ConfigPropName.MAPBOX_ACCESS_TOKEN) || DEFAULT_MAPBOX_TOKEN)

    return (
      <NoScrollContainer>
        <DeckGL
          style={{ mixBlendMode: 'multiply' }}
          controller={CONTROLLER_OPTIONS}
          viewState={viewState}
          onViewStateChange={this.handleViewStateChange}
          layers={this.getLayers()}
          children={({ width, height, viewState }: any) => (
            mapboxAccessToken && <StaticMap
              mapboxApiAccessToken={mapboxAccessToken}
              width={width} height={height} viewState={viewState}
            />
          )}
        />
        {flows &&
        <>
          <Box bottom={28} right={0}>
            <Collapsible
              width={160}
              direction={Direction.RIGHT}
            >
              <Column spacing={10} padding={12}>
                <LegendTitle>Location totals</LegendTitle>
                <LocationTotalsLegend colors={colors} />
              </Column>
            </Collapsible>
          </Box>
        </>}
        {unknownLocations && flows && allFlows &&
          <WarningBox top={10} right={10}>
            <WarningTitle>Warning</WarningTitle>
            {`${allFlows.length - flows.length} flows were omitted which
            referred to the following missing locations:`}
            <br/><br/>
            {Array.from(unknownLocations).sort().map(id => `"${id}"`).join(', ')}
          </WarningBox>
        }
        <TitleBox top={60} left={0}>
          <Collapsible
            width={300}
            direction={Direction.LEFT}
          >
            <Column spacing={10} padding={12}>
              {title &&
              <div>
                <Title>{title}</Title>
                {description}
              </div>
              }
              {sourceName && sourceUrl &&
              <div>
                {'Original data source: '}
                <>
                  <a href={sourceUrl} target="_blank" rel="noopener">{sourceName}</a>
                </>
              </div>}
              <div>
                {'Data behind this map is in '}
                <a href={`https://docs.google.com/spreadsheets/d/${spreadSheetKey}`}
                   target="_blank"
                   rel="noopener"
                >this spreadsheet</a>. You can <Link to="/">publish your own</Link> too.
              </div>
            </Column>
          </Collapsible>
        </TitleBox>
        <Absolute top={10} left={10}>
          <Logo />
        </Absolute>
        {tooltip && <Tooltip {...tooltip} />}
      </NoScrollContainer>
    )
  }
}


export default withFetchSheets(['properties', 'locations', 'flows'])(FlowMap as any)
